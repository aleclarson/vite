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
const pendingImports = new Map<string, string>()

export async function ssrLoadModule(
  url: string,
  server: ViteDevServer,
  context: SSRContext = { global },
  urlStack: string[] = []
): Promise<SSRModule> {
  url = unwrapId(url)

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
    .catch(() => {
      pendingImports.delete(url)
    })
    .then(() => {
      pendingModules.delete(url)
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

  const ssrImport = async (dep: string) => {
    if (isExternal(dep)) {
      return nodeRequire(dep, mod.file, resolveOptions)
    }
    dep = unwrapId(dep)
    const pendingImport = pendingImports.get(dep)
    if (!pendingImport || !urlStack.includes(pendingImport)) {
      pendingImports.set(url, dep)
      await ssrLoadModule(dep, server, context, urlStack)
      pendingImports.delete(url)
    }
    return moduleGraph.urlToModuleMap.get(dep)?.ssrModule
  }

  const ssrDynamicImport = (dep: string) => {
    // #3087 dynamic import vars is ignored at rewrite import path,
    // so here need process relative path
    if (!isExternal(dep) && dep.startsWith('.')) {
      dep = path.posix.resolve(path.dirname(url), dep)
    }
    return ssrImport(dep)
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
    : `(0,async function(${Object.keys(ssrArguments)}){\n${result.code}\n})`

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
      const AsyncFunction = async function () {}.constructor as typeof Function
      ssrModuleInit = new AsyncFunction(
        ...Object.keys(ssrArguments),
        ssrModuleImpl
      )
    } else {
      // Use the slower `vm.runInThisContext` for better sourcemap support.
      const vm = require('vm') as typeof import('vm')
      ssrModuleInit = vm.runInThisContext(ssrModuleImpl, {
        filename: mod.file || mod.url,
        columnOffset: 1,
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
        clear: server.config.clearScreen,
        error: e
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
