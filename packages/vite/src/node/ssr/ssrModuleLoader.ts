import path from 'path'
import * as convertSourceMap from 'convert-source-map'
import { ViteDevServer } from '..'
import { unwrapId } from '../utils'
import { ssrRewriteStacktrace } from './ssrStacktrace'
import {
  ssrExportAllKey,
  ssrModuleExportsKey,
  ssrImportKey,
  ssrImportMetaKey,
  ssrDynamicImportKey
} from './ssrTransform'
import { transformRequest } from '../server/transformRequest'
import { injectSourcesContent } from '../server/sourcemap'
import { InternalResolveOptions, tryNodeResolve } from '../plugins/resolve'

interface SSRContext {
  global: NodeJS.Global
}

type SSRModule = Record<string, any>

const pendingModules = new Map<string, Promise<SSRModule>>()
const pendingImports = new Map<string, Set<string>>()

export async function ssrLoadModule(
  url: string,
  server: ViteDevServer,
  context: SSRContext = { global },
  urlStack: string[] = []
): Promise<SSRModule> {
  url = unwrapId(url)

  if (urlStack.includes(url)) {
    server.config.logger.warn(
      `Circular dependency: ${urlStack.join(' -> ')} -> ${url}`
    )
    return {}
  }

  // when we instantiate multiple dependency modules in parallel, they may
  // point to shared modules. We need to avoid duplicate instantiation attempts
  // by register every module as pending synchronously so that all subsequent
  // request to that module are simply waiting on the same promise.
  const pending = pendingModules.get(url)
  if (pending) {
    return pending
  }

  const modulePromise = instantiateModule(url, server, context, urlStack)
  pendingModules.set(url, modulePromise)
  modulePromise
    .catch(() => {})
    .then(() => {
      pendingModules.delete(url)
      pendingImports.delete(url)
    })
  return modulePromise
}

async function instantiateModule(
  url: string,
  server: ViteDevServer,
  context: SSRContext = { global },
  urlStack: string[] = []
): Promise<SSRModule> {
  const { moduleGraph } = server
  const mod = await moduleGraph.ensureEntryFromUrl(url)

  if (mod.ssrModule) {
    return mod.ssrModule
  }

  const result =
    mod.ssrTransformResult ||
    (await transformRequest(url, server, { ssr: true }))
  if (!result) {
    // TODO more info? is this even necessary?
    throw new Error(`failed to load module for ssr: ${url}`)
  }

  urlStack = urlStack.concat(url)

  const ssrModule = {
    [Symbol.toStringTag]: 'Module'
  }
  Object.defineProperty(ssrModule, '__esModule', { value: true })

  // Tolerate circular imports by ensuring the module can be
  // referenced before it's been instantiated.
  mod.ssrModule = ssrModule

  const isExternal = (dep: string) => dep[0] !== '.' && dep[0] !== '/'

  if (result.deps?.length) {
    // Store the parsed dependencies while this module is loading,
    // so dependent modules can avoid waiting on a circular import.
    pendingImports.set(url, new Set(result.deps))

    // Load dependencies one at a time to ensure modules are
    // instantiated in a predictable order.
    await result.deps.reduce(
      (queue, dep) =>
        isExternal(dep)
          ? queue
          : queue.then(async () => {
              const deps = pendingImports.get(dep)
              if (!deps || !urlStack.some((url) => deps.has(url))) {
                await ssrLoadModule(dep, server, context, urlStack)
              }
            }),
      Promise.resolve()
    )
  }

  const {
    isProduction,
    resolve: { dedupe },
    root
  } = server.config

  const resolveOptions: InternalResolveOptions = {
    conditions: ['node'],
    dedupe,
    isBuild: true,
    isProduction,
    // Disable "module" condition.
    isRequire: true,
    mainFields: ['main'],
    root
  }

  const ssrImport = (dep: string) => {
    if (isExternal(dep)) {
      return nodeRequire(dep, mod.file, resolveOptions)
    } else {
      return moduleGraph.urlToModuleMap.get(unwrapId(dep))?.ssrModule
    }
  }

  const ssrDynamicImport = (dep: string) => {
    if (isExternal(dep)) {
      return Promise.resolve(nodeRequire(dep, mod.file, resolveOptions))
    } else {
      // #3087 dynamic import vars is ignored at rewrite import path,
      // so here need process relative path
      if (dep.startsWith('.')) {
        dep = path.posix.resolve(path.dirname(url), dep)
      }
      return ssrLoadModule(dep, server, context, urlStack)
    }
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
    global: context.global,
    [ssrModuleExportsKey]: ssrModule,
    [ssrImportMetaKey]: ssrImportMeta,
    [ssrImportKey]: ssrImport,
    [ssrDynamicImportKey]: ssrDynamicImport,
    [ssrExportAllKey]: ssrExportAll
  }

  let ssrModuleImpl = isProduction
    ? result.code + `\n//# sourceURL=${mod.url}`
    : `(0,function(${Object.keys(ssrArguments)}){\n${result.code}\n})`

  const { map } = result
  if (map?.mappings) {
    if (mod.file) {
      await injectSourcesContent(map, mod.file, moduleGraph)
    }

    ssrModuleImpl += `\n` + convertSourceMap.fromObject(map).toComment()
  }

  try {
    let ssrModuleInit: Function
    if (isProduction) {
      // Use the faster `new Function` in production.
      ssrModuleInit = new Function(...Object.keys(ssrArguments), ssrModuleImpl)
    } else {
      // Use the slower `vm.runInThisContext` for better sourcemap support.
      const vm = require('vm') as typeof import('vm')
      ssrModuleInit = vm.runInThisContext(ssrModuleImpl, {
        filename: mod.file || mod.url,
        displayErrors: false
      })
    }
    ssrModuleInit(...Object.values(ssrArguments))
  } catch (e) {
    try {
      e.stack = ssrRewriteStacktrace(e, moduleGraph)
    } catch {}
    server.config.logger.error(
      `Error when evaluating SSR module ${url}:\n\n${e.stack}`,
      {
        timestamp: true,
        clear: server.config.clearScreen
      }
    )
    throw e
  }

  return Object.freeze(ssrModule)
}

function nodeRequire(
  id: string,
  importer: string | null,
  resolveOptions: InternalResolveOptions
) {
  const resolved = tryNodeResolve(id, importer, resolveOptions, false)
  if (!resolved) {
    throw Error(`Cannot find module '${id}'`)
  }
  const mod = require(resolved.id)
  const defaultExport = mod.__esModule ? mod.default : mod
  // rollup-style default import interop for cjs
  return new Proxy(mod, {
    get(mod, prop) {
      if (prop === 'default') return defaultExport
      return mod[prop]
    }
  })
}
