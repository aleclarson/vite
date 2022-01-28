import vm from 'vm'
import path from 'path'
import { Module } from 'module'
import * as convertSourceMap from 'convert-source-map'
import { ViteDevServer } from '../server'
import { createDebugger, lookupFile, unwrapId } from '../utils'
import { ssrRewriteStacktrace } from './ssrStacktrace'
import {
  ssrExportAllKey,
  ssrModuleExportsKey,
  ssrImportKey,
  ssrImportMetaKey,
  ssrDynamicImportKey
} from './ssrTransform'
import { TransformResult } from '../server/transformRequest'
import { InternalResolveOptions, tryNodeResolve } from '../plugins/resolve'
import { hookNodeResolve } from '../plugins/ssrRequireHook'
import { createSSRExternalsFilter, resolveSSRExternal } from './ssrExternal'
import { ModuleNode } from '../server/moduleGraph'
import { loadPackageData } from '../packages'
import chalk from 'chalk'

const isDebug = !!process.env.DEBUG
const debug = createDebugger('vite:ssr')
const warn = (...msg: string[]) => debug(chalk.yellow('warn ') + msg.join(' '))

const E_SERVER_CLOSED = 'Server is closed'

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
  env: ImportMetaEnv
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
  purging: Set<Promise<any>>
  /**
   * Invalidate the exports of any modules that directly or indirectly depend
   * on the given module IDs (dev server URLs and/or file paths).
   *
   * The invalidated modules won't be executed until needed by a `ssrLoadModule`
   * function call.
   */
  purge: (moduleIds: string | string[]) => Promise<ModuleNode[]>
}

export interface SSRPlugin {
  /**
   * Manually set the exports of a module, instead of loading
   * it from the filesystem.
   */
  setExports?(id: string): SSRModuleExports | null | void
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
  env: { ...server.config.env, SSR: true } as ImportMetaEnv,
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
  purging: new Set(),
  async purge(moduleIds) {
    const purged: ModuleNode[] = []
    const purgeModulesRecursively = async (url: string) => {
      if (this.executedModules.delete(url)) {
        if (isDebug) {
          debug(`Purging module: "${url}"`)
        }

        const node = server.moduleGraph.urlToModuleMap.get(url)
        if (node) {
          purged.push(node)
        }

        // Invalidate the modules that statically imported
        // this module, then await their invalidation.
        let staticImporters: readonly string[]
        try {
          const mod = await this.resolvedModules.get(url)
          staticImporters = mod!.staticImporters
        } catch {
          // The module failed to resolve earlier, so fetch its
          // importers from its module graph node.
          staticImporters = node
            ? Array.from(node.staticImporters, (mod) => mod.url)
            : []
        }

        this.resolvedModules.delete(url)
        await Promise.all(staticImporters.map(purgeModulesRecursively))
        return true
      }
      return false
    }

    // Wait for previous execution to finish.
    // By waiting, we avoid a race condition where a circular import is
    // performed after its dependency is invalidated, but before it's been
    // resolved, leading to an undefined module being returned.
    while (this.loadingEntries.size) {
      await Promise.all(this.loadingEntries)
    }

    const purging = Promise.all<any>(
      (Array.isArray(moduleIds) ? moduleIds : [moduleIds]).map(async (id) => {
        // The given ID may be a file path or a dev URL.
        const mod = await server.moduleGraph.getModuleByUrl(id)
        if (mod) {
          return purgeModulesRecursively(mod.url)
        }
        const fileModules = server.moduleGraph.getModulesByFile(id)
        if (fileModules) {
          return Promise.all(
            Array.from(fileModules, (mod) => purgeModulesRecursively(mod.url))
          )
        }
        if (isDebug) {
          warn(`Skipping reload. No modules found for "${id}"`)
        }
      })
    )

    this.purging.add(purging)
    try {
      await purging
    } finally {
      this.purging.delete(purging)
    }

    return purged
  }
})

export type SSRStackFrame = {
  url: string
  file: string | null
  line: number | null
}

export async function ssrLoadModule(
  url: string,
  server: ViteDevServer,
  context?: SSRContext,
  importChain?: SSRStackFrame[],
  line?: number | null
): Promise<SSRModuleExports>

export async function ssrLoadModule(
  urls: string[],
  server: ViteDevServer,
  context?: SSRContext,
  importChain?: SSRStackFrame[],
  line?: number | null
): Promise<SSRModuleExports[]>

export async function ssrLoadModule(
  url: string | string[],
  server: ViteDevServer,
  context = ssrCreateContext(server),
  importChain: SSRStackFrame[] = [],
  line?: number | null
): Promise<SSRModuleExports | SSRModuleExports[]> {
  if (server.closed) {
    throw Error(E_SERVER_CLOSED)
  }
  if (Array.isArray(url)) {
    // Load multiple entries in parallel.
    return Promise.all(
      url.map((url) => ssrLoadModule(url, server, context, importChain))
    )
  }
  // Wait for module purging to finish.
  while (context.purging.size) {
    await Promise.all(context.purging)
  }
  url = unwrapId(url)
  let executing = context.executedModules.get(url)
  if (!executing) {
    const importer = importChain[importChain.length - 1]?.url

    let resolving = context.resolvedModules.get(url)
    if (!resolving) {
      for (const plugin of context.plugins) {
        const exports = plugin.setExports?.(url)
        if (exports != null) {
          context.executedModules.set(url, Promise.resolve(exports))
          return exports
        }
      }

      resolving = resolveModule(url, server, importer)
      context.resolvedModules.set(url, resolving)
    }

    context.executedModules.set(
      url,
      (executing = resolving.then((ssrModule) =>
        executeModule(ssrModule, server, context, importChain, line)
      ))
    )
    executing.catch((e) => {
      if (!e.originalStack && e.message !== E_SERVER_CLOSED) {
        try {
          ssrRewriteStacktrace(e, server.moduleGraph)
        } catch {}
      }
    })

    // Track the promises for entry modules.
    if (!importer) {
      debug(`Loading entry: "${url}"`)
      const entryPromise = executing.catch(() => {})
      context.loadingEntries.add(entryPromise)
      entryPromise.then((exports) => {
        context.loadingEntries.delete(entryPromise)
        debug(`Loaded entry: "${url}" (${context.loadingEntries.size} left)`)
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
  const transformResult = await server.transformRequest(url, { ssr: true })
  if (!transformResult) {
    if (isDebug) {
      warn(`Module was resolved, but has no source code: "${url}"`)
    }
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
  importChain: SSRStackFrame[],
  line?: number | null
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

  importChain = importChain.concat({
    url: importer.url,
    file: importer.file,
    line: line ?? null
  })

  async function ssrImport(
    dep: string,
    line: number | null,
    isDynamic?: boolean
  ) {
    if (server._pendingReload) {
      // Wait for "server._ssrExternals" to be updated
      await server._pendingReload
    }
    if (dep[0] !== '/') {
      let isExternal = context.isExternal(dep)
      if (!isExternal) {
        const resolved = await server.pluginContainer.resolveId(
          dep,
          importer.file || importer.url,
          undefined,
          true
        )
        if (resolved?.external) {
          isExternal = true
          dep = resolved.id
        }
      }
      if (isExternal) {
        return nodeRequire(dep, filename, resolveOptions, server)
      }
    }
    // Circular imports resolve with an incomplete module, so
    // imported values cannot be used in top-level statements.
    const dupeIndex = importChain.findIndex((importer) => importer.url === dep)
    if (dupeIndex >= 0) {
      if (isDebug) {
        warn(
          `Circular import may lead to unexpected behavior\n `,
          importChain
            .slice(dupeIndex)
            .map((importer) => importer.url)
            .concat(dep)
            .join(' → ')
        )
      }
      return (await context.resolvedModules.get(dep))!.exports
    }
    return ssrLoadModule(
      dep,
      server,
      context,
      isDynamic ? [] : importChain,
      line
    )
  }

  async function ssrDynamicImport(url: string) {
    // Only dynamic imports need to resolve their URL at runtime,
    // because the URL may be a dynamic string that only exists
    // at runtime, whereas static imports are preprocessed.
    const [dep] = await server.moduleGraph.resolveUrl(url)

    // We want dynamic imports to be treated like entry modules,
    // so the URL stack needs to be empty. Since circular imports
    // are not a concern for dynamic imports, this is okay.
    return ssrImport(dep, null, true)
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

  const ssrImportMeta = { url: importer.url, env: context.env }
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
    if (!e.ssrStack) {
      const firstFrame =
        e.constructor.name === 'SyntaxError'
          ? e.stack.match(/^[^\n]+/)![0]
          : e.stack.match(/^ {4}at (.+)$/m)![1]

      e.message += (e.ssrStack = importChain
        .slice(0, -1)
        .map((importer, i) => {
          const source = importer.file || importer.url
          const { line } = importChain[i + 1]
          return source + (line ? ':' + line : '')
        })
        .concat(firstFrame)
        .reverse())
        .map((url: string) => `\n    at ${url}`)
        .join('')
    }
    postHooks.forEach((postHook) => postHook(e))
    throw e
  }

  debug(`Executed module: "${importer.url}"`)
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
