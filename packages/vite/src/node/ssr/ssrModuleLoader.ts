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
import {
  InternalResolveOptions,
  loadPackageData,
  tryNodeResolve
} from '../plugins/resolve'
import { hookNodeResolve } from '../plugins/ssrRequireHook'
import { createSSRExternalsFilter, resolveSSRExternal } from './ssrExternal'
import { ModuleNode } from '../server/moduleGraph'

type SSRModule = Record<string, any>
type SSRModuleNode = ModuleNode & {
  ssrTransformResult: TransformResult & { deps: string[] }
}

/**
 * This context ensures a module is never loaded twice.
 *
 * The `resolvedModules` cache holds the promise for each module before
 * they have been fully executed, allowing for circular imports.
 *
 * The `executedModules` cache allows `ssrImport` to wait for a dependency
 * to load transitive dependencies and define exports before the importer
 * can use it.
 */
export interface SSRContext {
  /** Promises for loading entry modules and dynamic imports */
  loadingEntries: Set<Promise<any>>
  /** Promise cache for `resolveModule` calls */
  resolvedModules: Map<string, Promise<SSRModule>>
  /** Promise cache for `executeModule` calls */
  executedModules: Map<string, Promise<SSRModule>>
  /** For mapping SSR modules to their metadata */
  moduleNodes: WeakMap<SSRModule, SSRModuleNode>
  /** Returns true if a module should be executed w/o preprocessing */
  isExternal: (url: string) => boolean
  /** Force a module and its importers to reload */
  reload: (url: string) => Promise<void>
}

export const ssrCreateContext = (server: ViteDevServer): SSRContext => ({
  loadingEntries: new Set(),
  resolvedModules: new Map(),
  executedModules: new Map(),
  moduleNodes: new WeakMap(),
  isExternal: createSSRExternalsFilter(
    (server._ssrExternals ||= resolveSSRExternal(
      server.config,
      server._optimizeDepsMetadata
        ? Object.keys(server._optimizeDepsMetadata.optimized)
        : []
    )),
    server.config.ssr?.noExternal
  ),
  async reload(url: string) {
    const invalidated = new Set<string>()
    const invalidate = (mod: ModuleNode): boolean => {
      const url = mod.url
      if (invalidated.has(url)) {
        return true
      }
      if (this.resolvedModules.delete(url)) {
        this.executedModules.delete(url)
        invalidated.add(url)

        // Reload any importers.
        const isEntry = !Array.from(mod.staticImporters, invalidate).some(
          Boolean
        )

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

    // Invalidate pathname or filename.
    const mod = await server.moduleGraph.getModuleByUrl(url)
    if (mod) {
      invalidate(mod)
    } else {
      server.moduleGraph.getModulesByFile(url)?.forEach(invalidate)
    }

    // Wait for reloading to finish.
    await Promise.all(this.loadingEntries)
  }
})

export async function ssrLoadModule(
  url: string,
  server: ViteDevServer,
  context?: SSRContext,
  urlStack?: string[]
): Promise<SSRModule>

export async function ssrLoadModule(
  urls: string[],
  server: ViteDevServer,
  context?: SSRContext,
  urlStack?: string[]
): Promise<SSRModule[]>

export async function ssrLoadModule(
  url: string | string[],
  server: ViteDevServer,
  context = ssrCreateContext(server),
  urlStack: string[] = []
): Promise<SSRModule | SSRModule[]> {
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
      resolving = resolveModule(url, server, context, importer)
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

    if (!importer) {
      const entryPromise = executing.catch(() => {})
      context.loadingEntries.add(entryPromise)
      entryPromise.then(() => {
        context.loadingEntries.delete(entryPromise)
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
  context: SSRContext,
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
  const transformed = await transformRequest(url, server, { ssr: true })
  if (!transformed) {
    onFailedImport(new Error('Failed to resolve'), url, importer)
  }

  const ssrModule: SSRModule = { [Symbol.toStringTag]: 'Module' }
  Object.defineProperty(ssrModule, '__esModule', { value: true })
  context.moduleNodes.set(ssrModule, mod as SSRModuleNode)
  return ssrModule
}

async function executeModule(
  ssrModule: SSRModule,
  server: ViteDevServer,
  context: SSRContext,
  urlStack: string[]
): Promise<SSRModule> {
  // This is named "importer" to make ssrImport easier to read.
  const importer = context.moduleNodes.get(ssrModule)!
  urlStack = urlStack.concat(importer.url)

  const {
    isProduction,
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
    root
  }

  // Always resolve peerDependencies from the project root.
  // Otherwise, linked packages may use their version from devDependencies.
  const filename = importer.file
  if (filename) {
    resolveOptions.dedupe = dedupePeerDeps(filename, resolveOptions)
  }

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
      return context.resolvedModules.get(dep)
    }
    return ssrLoadModule(dep, server, context, importChain)
  }

  async function ssrDynamicImport(url: string) {
    const [dep] = await server.moduleGraph.resolveUrl(url)
    return ssrImport(dep, [])
  }

  function ssrExportAll(sourceModule: any) {
    for (const key in sourceModule) {
      if (key !== 'default') {
        Object.defineProperty(ssrModule, key, {
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
    [ssrModuleExportsKey]: ssrModule,
    [ssrImportMetaKey]: ssrImportMeta,
    [ssrImportKey]: ssrImport,
    [ssrDynamicImportKey]: ssrDynamicImport,
    [ssrExportAllKey]: ssrExportAll
  }

  let { code, map } = importer.ssrTransformResult
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

  await initialize(...Object.values(ssrArguments))
  return Object.freeze(ssrModule)
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
      const pkg = loadPackageData(pkgPath, options.preserveSymlinks).data
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
