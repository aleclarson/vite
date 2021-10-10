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
import { injectSourcesContent } from '../server/sourcemap'
import {
  InternalResolveOptions,
  loadPackageData,
  tryNodeResolve
} from '../plugins/resolve'
import { hookNodeResolve } from '../plugins/ssrRequireHook'
import { createSSRExternalsFilter } from './ssrExternal'

type SSRModule = Record<string, any>

interface ModuleContext {
  /** Pending transform requests by their URL */
  pendingTransforms: Map<string, Promise<TransformResult>>
  /** Pending modules by their URL */
  pendingModules: Map<string, Promise<SSRModule>>
  /** Loaded modules by their URL */
  modules: Map<string, SSRModule>
  /** Unresolved imports by importer URL */
  imports: Map<string, string[]>
  /** Returns true if a module should be loaded with Node require */
  isExternal: (dep: string) => boolean
}

export async function ssrLoadModule(
  url: string,
  server: ViteDevServer,
  nodeGlobal?: NodeJS.Global,
  urlStack?: string[],
  context?: ModuleContext
): Promise<SSRModule>

export async function ssrLoadModule(
  urls: string[],
  server: ViteDevServer,
  nodeGlobal?: NodeJS.Global,
  urlStack?: string[],
  context?: ModuleContext
): Promise<SSRModule[]>

export async function ssrLoadModule(
  url: string | string[],
  server: ViteDevServer,
  nodeGlobal: NodeJS.Global = global,
  urlStack: string[] = [],
  context?: ModuleContext
): Promise<SSRModule | SSRModule[]> {
  if (server.closed) {
    throw Error('Server is closed')
  }
  context ??= {
    pendingTransforms: new Map(),
    pendingModules: new Map(),
    modules: new Map(),
    imports: new Map(),
    isExternal: createSSRExternalsFilter(
      server._ssrExternals!,
      server.config.ssr?.noExternal
    )
  }
  if (Array.isArray(url)) {
    // Load multiple entries in parallel.
    return Promise.all(
      url.map((url) =>
        ssrLoadModule(url, server, nodeGlobal, urlStack, context)
      )
    )
  }
  url = unwrapId(url)
  let modulePromise = context.pendingModules.get(url)
  if (!modulePromise) {
    modulePromise = instantiateModule(
      url,
      server,
      nodeGlobal,
      urlStack,
      context
    )
    context.pendingModules.set(url, modulePromise)
    modulePromise.catch((e) => {
      if (!e.originalStack) {
        try {
          ssrRewriteStacktrace(e, server.moduleGraph)
        } catch {}
      }
    })
  }
  return modulePromise
}

async function instantiateModule(
  url: string,
  server: ViteDevServer,
  nodeGlobal: NodeJS.Global,
  urlStack: string[],
  context: ModuleContext
): Promise<SSRModule> {
  const { moduleGraph } = server
  const mod = await moduleGraph.ensureEntryFromUrl(url)

  if (mod.ssrModule) {
    return mod.ssrModule
  }

  const ssrModule = {
    [Symbol.toStringTag]: 'Module'
  }
  Object.defineProperty(ssrModule, '__esModule', { value: true })

  // Tolerate circular imports by ensuring the module can be
  // referenced before it's been instantiated.
  context.modules.set(url, ssrModule)

  const { code, map, deps } =
    mod.ssrTransformResult ||
    (await (context.pendingTransforms.get(url) ||
      ssrTransformRequest(url, undefined, server, context)))

  // Transform dependencies eagerly to reduce load times, but don't
  // wait for them to finish, since ssrImport will do that.
  deps!.forEach((dep) => {
    if (dep[0] === '/' || !context.isExternal(dep)) {
      ssrTransformRequest(dep, url, server, context)
    }
  })

  urlStack = urlStack.concat(url)
  const isCircular = (url: string) => urlStack.includes(url)

  const {
    isProduction,
    logger,
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
  const filename = mod.file
  if (filename) {
    resolveOptions.dedupe = dedupePeerDeps(filename, resolveOptions)
  }

  // Since dynamic imports can happen in parallel, we need to
  // account for multiple pending deps and duplicate imports.
  const imports: string[] = []

  const ssrImport = async (dep: string) => {
    if (server._pendingReload) {
      // Wait for "server._ssrExternals" to be updated
      await server._pendingReload
    }
    if (dep[0] !== '/' && context.isExternal(dep)) {
      return nodeRequire(dep, filename, resolveOptions)
    }
    if (!isCircular(dep) && !context.imports.get(dep)?.some(isCircular)) {
      imports.push(dep)
      if (imports.length === 1) {
        context.imports.set(url, imports)
      }
      try {
        return await ssrLoadModule(dep, server, nodeGlobal, urlStack, context)
      } finally {
        if (imports.length === 1) {
          context.imports.delete(url)
        } else {
          imports.splice(imports.indexOf(dep), 1)
        }
      }
    }
    return context.modules.get(dep)
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

  const ssrImportMeta = { url }
  const ssrArguments: Record<string, any> = {
    global: nodeGlobal,
    [ssrModuleExportsKey]: ssrModule,
    [ssrImportMetaKey]: ssrImportMeta,
    [ssrImportKey]: ssrImport,
    [ssrDynamicImportKey]: ssrImport,
    [ssrExportAllKey]: ssrExportAll
  }

  let ssrModuleImpl =
    `(0,async function(${Object.keys(ssrArguments)}){\n` + code + `\n})`

  if (map?.mappings) {
    if (filename) {
      map.file = filename
      await injectSourcesContent(map, filename, logger, moduleGraph)
    }

    ssrModuleImpl += `\n` + convertSourceMap.fromObject(map).toComment()
  }

  const ssrModuleInit = vm.runInThisContext(ssrModuleImpl, {
    filename: filename || mod.url,
    displayErrors: false
  })

  await ssrModuleInit(...Object.values(ssrArguments))

  mod.ssrModule = Object.freeze(ssrModule)
  return ssrModule
}

async function ssrTransformRequest(
  url: string,
  importer: string | undefined,
  server: ViteDevServer,
  context: ModuleContext
) {
  let request = context.pendingTransforms.get(url)
  if (!request) {
    context.pendingTransforms.set(
      url,
      (request = transformRequest(url, server, { ssr: true }).then((result) => {
        if (result === null) {
          // Mimic an error from failed dynamic import.
          const err: any = new Error(`Cannot find module '${url}'`)
          if (importer) {
            err.message += ` imported from ${importer}`
          }
          err.code = 'ERR_MODULE_NOT_FOUND'
          throw err
        }
        context.pendingTransforms.delete(url)
        return result
      }))
    )
    // Ignore unhandled rejection until the module is imported.
    request.catch(() => {})
  }
  return request
}

function nodeRequire(
  id: string,
  importer: string | null,
  resolveOptions: InternalResolveOptions
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
      const resolved = tryNodeResolve(id, parent.id, resolveOpts, false)
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
      const pkg = loadPackageData(pkgPath).data
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
