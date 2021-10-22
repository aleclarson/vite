import vm from 'vm'
import path from 'path'
import { Module } from 'module'
import * as convertSourceMap from 'convert-source-map'
import { ViteDevServer } from '../server'
import { lookupFile, unwrapId } from '../utils'
import { ssrRewriteStacktrace } from './ssrStacktrace'
import {
  ssrExportAllKey,
  ssrModuleExportsKey,
  ssrImportKey,
  ssrImportMetaKey,
  ssrDynamicImportKey
} from './ssrTransform'
import { transformRequest, TransformResult } from '../server/transformRequest'
import { InternalResolveOptions, tryNodeResolve } from '../plugins/resolve'
import { hookNodeResolve } from '../plugins/ssrRequireHook'
import { createSSRExternalsFilter, resolveSSRExternal } from './ssrExternal'
import { ModuleNode } from '../server/moduleGraph'
import { loadPackageData } from '../packages'

export type SSRModuleExports = Record<string, any>

export interface SSRModule {
  url: string
  file: string | null
  exports: SSRModuleExports
  transformResult: Readonly<TransformResult>
  staticImporters: readonly string[]
}

/**
 * This context ensures a module is never loaded twice, unless
 * explicitly asked to be.
 *
 * The `resolvedModules` cache holds the promise for each module before
 * they have been fully executed, allowing for circular imports.
 *
 * The `executedModules` cache allows `ssrImport` to wait for a dependency
 * to load transitive dependencies and define exports before the importer
 * can use it.
 */
export interface SSRContext {
  plugins: SSRPlugin[]
  /** This accumulates entry modules until `loadingEntries` is empty */
  loadedEntries: Set<Promise<SSRModule>>
  /** Promises for loading entry modules and dynamic imports */
  loadingEntries: Set<Promise<any>>
  /** Promise cache for `resolveModule` calls */
  resolvedModules: Map<string, Promise<SSRModule>>
  /** Promise cache for `executeModule` calls */
  executedModules: Map<string, Promise<SSRModuleExports>>
  /** Returns true if a module should be executed w/o preprocessing */
  isExternal: (url: string) => boolean
  /** Force one or many modules and their importers to reload */
  reload: (moduleIds: string | string[]) => Promise<void>
}

export interface SSRPlugin {
  /**
   * The given `module` is about to be executed.
   *
   * If a function is returned, it's called after the `module`
   * has finished executing or failed while executing.
   */
  executeModule?(module: Readonly<SSRModule>): ((error?: any) => void) | void
  /**
   * The given `entries` have finished loading.
   */
  loadedEntries?(entries: Readonly<SSRModule>[]): void
}

export const ssrCreateContext = (
  server: ViteDevServer,
  plugins: SSRPlugin[] = []
): SSRContext => ({
  plugins,
  loadedEntries: new Set(),
  loadingEntries: new Set(),
  resolvedModules: new Map(),
  executedModules: new Map(),
  isExternal: createSSRExternalsFilter(
    (server._ssrExternals ||= resolveSSRExternal(
      server.config,
      server._optimizeDepsMetadata
        ? Object.keys(server._optimizeDepsMetadata.optimized)
        : []
    )),
    server.config.ssr?.noExternal
  ),
  async reload(moduleIds) {
    const invalidated = new Set<string>()
    const invalidate = async (url: string) => {
      if (invalidated.has(url)) {
        return true
      }
      if (this.executedModules.delete(url)) {
        invalidated.add(url)

        const mod = (await this.resolvedModules.get(url))!
        this.resolvedModules.delete(url)

        // Invalidate any importers.
        const isEntry = !(
          await Promise.all(mod.staticImporters.map(invalidate))
        ).some(Boolean)

        // Reload this module if not imported by any
        // module used in the current SSR context.
        if (isEntry) {
          ssrLoadModule(url, server, this)
        }

        return true
      }
      return false
    }

    // Wait for previous execution to finish.
    // By waiting, we avoid a race condition where a circular import is
    // performed after its dependency is invalidated, but before it's been
    // resolved, leading to an undefined module being returned.
    await Promise.all(this.loadingEntries)

    await Promise.all<any>(
      (Array.isArray(moduleIds) ? moduleIds : [moduleIds]).map(async (id) => {
        // The given ID may be a file path or a dev URL.
        const mod = await server.moduleGraph.getModuleByUrl(id)
        return mod
          ? invalidate(mod.url)
          : Promise.all(
              Array.from(server.moduleGraph.getModulesByFile(id) || [], (mod) =>
                invalidate(mod.url)
              )
            )
      })
    )

    // Wait for reloading to finish.
    await Promise.all(this.loadingEntries)
  }
})

export async function ssrLoadModule(
  url: string,
  server: ViteDevServer,
  context?: SSRContext,
  urlStack?: string[]
): Promise<SSRModuleExports>

export async function ssrLoadModule(
  urls: string[],
  server: ViteDevServer,
  context?: SSRContext,
  urlStack?: string[]
): Promise<SSRModuleExports[]>

export async function ssrLoadModule(
  url: string | string[],
  server: ViteDevServer,
  context = ssrCreateContext(server),
  urlStack: string[] = []
): Promise<SSRModuleExports | SSRModuleExports[]> {
  if (server.closed) {
    throw Error('Server is closed')
  }
  if (Array.isArray(url)) {
    // Load multiple entries in parallel.
    return Promise.all(
      url.map((url) => ssrLoadModule(url, server, context, urlStack))
    )
  }
  url = unwrapId(url)
  let executing = context.executedModules.get(url)
  if (!executing) {
    const importer = urlStack[urlStack.length - 1]

    let resolving = context.resolvedModules.get(url)
    if (!resolving) {
      resolving = resolveModule(url, server, importer)
      context.resolvedModules.set(url, resolving)
    }

    context.executedModules.set(
      url,
      (executing = resolving.then((ssrModule) =>
        executeModule(ssrModule, server, context, urlStack)
      ))
    )
    executing.catch((e) => {
      if (!e.originalStack) {
        try {
          ssrRewriteStacktrace(e, server.moduleGraph)
        } catch {}
      }
    })

    // Track the promises for entry modules.
    if (!importer) {
      const entryPromise = executing.catch(() => {})
      context.loadingEntries.add(entryPromise)
      entryPromise.then((exports) => {
        context.loadingEntries.delete(entryPromise)
        if (exports) {
          context.loadedEntries.add(resolving!)
        }
        // Any plugins with a `loadedEntries` hook defined will receive the
        // array of entry modules that loaded without error, but only after
        // all modules are finished executing.
        if (!context.loadingEntries.size) {
          Promise.all(context.loadedEntries).then((loadedEntries) => {
            for (const plugin of context.plugins) {
              plugin.loadedEntries?.(loadedEntries)
            }
          })
          context.loadedEntries.clear()
        }
      })
    }
  }
  return executing
}

function onFailedImport(error: any, url: string, importer?: string): never {
  // First error is thrown by `resolvePackageEntry` in vite:resolve
  // and the other is thrown by `resolveExports` in same plugin.
  if (/^(Failed to resolve|Missing "[^"]+" export)/.test(error.message)) {
    // Mimic an error from Node's native dynamic import.
    error.code = 'ERR_MODULE_NOT_FOUND'
    error.message = `Cannot find module '${url}'`
    if (importer) {
      error.message += ` imported from ${importer}`
    }
  }
  throw error
}

async function resolveModule(
  url: string,
  server: ViteDevServer,
  importer?: string
): Promise<SSRModule> {
  let mod: ModuleNode
  try {
    mod = await server.moduleGraph.ensureEntryFromUrl(url)
  } catch (e) {
    // Failed to resolve the module URL.
    onFailedImport(e, url, importer)
  }

  // Throw a resolution error if skipped by every load hook.
  const transformResult = await transformRequest(url, server, { ssr: true })
  if (!transformResult) {
    onFailedImport(new Error('Failed to resolve'), url, importer)
  }

  const exports = { [Symbol.toStringTag]: 'Module' }
  Object.defineProperty(exports, '__esModule', { value: true })

  return {
    url: mod.url,
    file: mod.file,
    exports,
    transformResult,
    staticImporters: Array.from(mod.staticImporters, (importer) => importer.url)
  }
}

async function executeModule(
  importer: SSRModule,
  server: ViteDevServer,
  context: SSRContext,
  urlStack: string[]
): Promise<SSRModuleExports> {
  const {
    isProduction,
    packageCache,
    resolve: { dedupe },
    root
  } = server.config

  const resolveOptions: InternalResolveOptions = {
    conditions: ['node'],
    dedupe,
    // Prefer CommonJS modules.
    extensions: ['.js', '.mjs', '.ts', '.jsx', '.tsx', '.json'],
    isBuild: true,
    isProduction,
    // Disable "module" condition.
    isRequire: true,
    mainFields: ['main'],
    packageCache,
    root
  }

  // Always resolve peerDependencies from the project root.
  // Otherwise, linked packages may use their version from devDependencies.
  const filename = importer.file
  if (filename) {
    resolveOptions.dedupe = dedupePeerDeps(filename, resolveOptions)
  }

  urlStack = urlStack.concat(importer.url)

  async function ssrImport(dep: string, importChain = urlStack) {
    if (server._pendingReload) {
      // Wait for "server._ssrExternals" to be updated
      await server._pendingReload
    }
    if (dep[0] !== '/' && context.isExternal(dep)) {
      return nodeRequire(dep, filename, resolveOptions, server)
    }
    // Circular imports resolve with an incomplete module, so
    // imported values cannot be used in top-level statements.
    if (importChain.includes(dep)) {
      return (await context.resolvedModules.get(dep))!.exports
    }
    return ssrLoadModule(dep, server, context, importChain)
  }

  async function ssrDynamicImport(url: string) {
    // Only dynamic imports need to resolve their URL at runtime,
    // because the URL may be a dynamic string that only exists
    // at runtime, whereas static imports are preprocessed.
    const [dep] = await server.moduleGraph.resolveUrl(url)

    // We want dynamic imports to be treated like entry modules,
    // so the URL stack needs to be empty. Since circular imports
    // are not a concern for dynamic imports, this is okay.
    return ssrImport(dep, [])
  }

  function ssrExportAll(sourceModule: any) {
    for (const key in sourceModule) {
      if (key !== 'default') {
        Object.defineProperty(importer.exports, key, {
          enumerable: true,
          configurable: true,
          get() {
            return sourceModule[key]
          }
        })
      }
    }
  }

  const ssrImportMeta = { url: importer.url }
  const ssrArguments: Record<string, any> = {
    [ssrModuleExportsKey]: importer.exports,
    [ssrImportMetaKey]: ssrImportMeta,
    [ssrImportKey]: ssrImport,
    [ssrDynamicImportKey]: ssrDynamicImport,
    [ssrExportAllKey]: ssrExportAll
  }

  const postHooks: ((error?: any) => void)[] = []
  for (const plugin of context.plugins) {
    const postHook = plugin.executeModule?.(importer)
    if (postHook) {
      postHooks.push(postHook)
    }
  }

  let { code, map } = importer.transformResult
  code = `(0,async function(${Object.keys(ssrArguments)}){\n` + code + `\n})`
  if (map?.mappings) {
    code += `\n` + convertSourceMap.fromObject(map).toComment()
  }

  // Using `vm.runInThisContext` is non-negotiable, because SSR externals
  // are loaded within this context, so we must ensure global built-ins
  // are identical to avoid type-checking bugs.
  const initialize = vm.runInThisContext(code, {
    filename: filename || importer.url,
    displayErrors: false
  })

  try {
    await initialize(...Object.values(ssrArguments))
    postHooks.forEach((postHook) => postHook())
  } catch (e) {
    postHooks.forEach((postHook) => postHook(e))
    throw e
  }

  return Object.freeze(importer.exports)
}

function nodeRequire(
  id: string,
  importer: string | null,
  resolveOptions: InternalResolveOptions,
  server: ViteDevServer
) {
  const resolveOptionsMap = new Map<string, InternalResolveOptions>()
  const unhookNodeResolve = hookNodeResolve(
    (nodeResolve) => (id, parent, isMain, options) => {
      if (id[0] === '.' || Module.builtinModules.includes(id)) {
        return nodeResolve(id, parent, isMain, options)
      }
      const resolveOpts = computeResolveOptions(
        parent.id,
        resolveOptions,
        resolveOptionsMap
      )
      const resolved = tryNodeResolve(id, parent.id, resolveOpts, false, server)
      if (!resolved) {
        throw Error(`Cannot find module '${id}' imported from '${parent.id}'`)
      }
      return resolved.id
    }
  )

  let mod: any
  try {
    const loadModule = Module.createRequire(
      importer || resolveOptions.root + '/'
    )
    mod = loadModule(id)
  } finally {
    unhookNodeResolve()
  }

  // rollup-style default import interop for cjs
  const defaultExport = mod.__esModule ? mod.default : mod
  return new Proxy(mod, {
    get(mod, prop) {
      if (prop === 'default') return defaultExport
      return mod[prop]
    }
  })
}

function computeResolveOptions(
  importer: string,
  resolveOptions: InternalResolveOptions,
  cache: Map<string, InternalResolveOptions>
) {
  let options = cache.get(importer)
  if (!options) {
    const dedupe = dedupePeerDeps(importer, resolveOptions)
    cache.set(
      importer,
      (options =
        dedupe !== resolveOptions.dedupe
          ? { ...resolveOptions, dedupe }
          : resolveOptions)
    )
  }
  return options
}

/**
 * Merge peer dependencies into `resolve.dedupe` array.
 */
function dedupePeerDeps(file: string, options: InternalResolveOptions) {
  if (
    file &&
    !file.includes('node_modules') &&
    !file.startsWith(options.root + '/')
  ) {
    const pkgPath = lookupFile(path.dirname(file), ['package.json'], true)
    if (pkgPath) {
      const pkg = loadPackageData(
        pkgPath,
        options.preserveSymlinks,
        options.packageCache
      ).data
      if (pkg.peerDependencies) {
        const dedupe = new Set(options.dedupe)
        const oldSize = dedupe.size
        Object.keys(pkg.peerDependencies).forEach((id) => dedupe.add(id))
        if (dedupe.size > oldSize) {
          return Array.from(dedupe)
        }
      }
    }
  }
  return options.dedupe
}
