import vm from 'vm'
import { Module } from 'module'
import * as convertSourceMap from 'convert-source-map'
import { createFilter } from '@rollup/pluginutils'
import { ViteDevServer } from '..'
import { unwrapId } from '../utils'
import { shouldExternalizeForSSR } from './ssrExternal'
import { rebindErrorStacktrace, ssrRewriteStacktrace } from './ssrStacktrace'
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
import { hookNodeResolve } from '../plugins/ssrRequireHook'

interface SSRContext {
  global: NodeJS.Global
}

type SSRModule = Record<string, any>

const pendingModules = new Map<string, Promise<SSRModule>>()
const pendingImports = new Map<string, string[]>()

export async function ssrWaitForModules(): Promise<void> {
  const ignoreError = () => {}
  await Promise.all(
    Array.from(pendingModules.values(), (modulePromise) =>
      modulePromise.catch(ignoreError)
    )
  )
  if (pendingModules.size) {
    await ssrWaitForModules()
  }
}

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
    .catch((e) => {
      pendingImports.delete(url)

      const { logger } = server.config
      if (!logger.hasErrorLogged(e)) {
        try {
          rebindErrorStacktrace(e, ssrRewriteStacktrace(e, server.moduleGraph))
        } catch {}

        logger.error(`Error when evaluating SSR module ${url}:\n\n${e.stack}`, {
          timestamp: true,
          clear: server.config.clearScreen,
          error: e
        })
      }
    })
    .finally(() => {
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

  const ssrModule = {
    [Symbol.toStringTag]: 'Module'
  }
  Object.defineProperty(ssrModule, '__esModule', { value: true })

  // Tolerate circular imports by ensuring the module can be
  // referenced before it's been instantiated.
  mod.ssrModule = ssrModule

  urlStack = urlStack.concat(url)
  const isCircular = (url: string) => urlStack.includes(url)

  // Since dynamic imports can happen in parallel, we need to
  // account for multiple pending deps and duplicate imports.
  const pendingDeps: string[] = []

  const {
    isProduction,
    logger,
    resolve: { dedupe },
    root,
    ssr
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

  // We need to check `ssr.noExternal` explicitly, because it might include
  // a deep import of a dependency that is otherwise externalized.
  const canBeExternal =
    ssr?.noExternal && ssr.noExternal !== true
      ? createFilter(undefined, ssr.noExternal, { resolve: false })
      : () => true

  const isExternal = (dep: string) =>
    dep[0] !== '/' &&
    canBeExternal(dep) &&
    (!server._optimizeDepsMetadata ||
      shouldExternalizeForSSR(dep, server._ssrExternals!))

  const ssrImport = async (dep: string) => {
    if (server._pendingReload) {
      // Wait for "server._ssrExternals" to be updated
      await server._pendingReload
    }
    if (isExternal(dep)) {
      return nodeRequire(dep, mod.file, resolveOptions)
    }
    if (!isCircular(dep) && !pendingImports.get(dep)?.some(isCircular)) {
      pendingDeps.push(dep)
      if (pendingDeps.length === 1) {
        pendingImports.set(url, pendingDeps)
      }
      await ssrLoadModule(dep, server, context, urlStack)
      if (pendingDeps.length === 1) {
        pendingImports.delete(url)
      } else {
        pendingDeps.splice(pendingDeps.indexOf(dep), 1)
      }
    }
    // Use `getModuleByUrl` instead of accessing `urlToModuleMap` directly
    // so that bare imports added to `ssr.noExternal` are normalized.
    const depModule = await moduleGraph.getModuleByUrl(dep)
    return depModule?.ssrModule
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
    [ssrDynamicImportKey]: ssrImport,
    [ssrExportAllKey]: ssrExportAll
  }

  let ssrModuleImpl =
    `(0,async function(${Object.keys(ssrArguments)}){\n` + result.code + `\n})`

  const { map } = result
  if (map?.mappings) {
    if (mod.file) {
      map.file = mod.file
      await injectSourcesContent(map, mod.file, logger, moduleGraph)
    }

    ssrModuleImpl += `\n` + convertSourceMap.fromObject(map).toComment()
  }

  const ssrModuleInit = vm.runInThisContext(ssrModuleImpl, {
    filename: mod.file || mod.url,
    displayErrors: false
  })

  await ssrModuleInit(...Object.values(ssrArguments))

  return Object.freeze(ssrModule)
}

function nodeRequire(
  id: string,
  importer: string | null,
  resolveOptions: InternalResolveOptions
) {
  const unhookNodeResolve = hookNodeResolve(
    (nodeResolve) => (id, parent, isMain, options) => {
      if (id[0] === '.' || Module.builtinModules.includes(id)) {
        return nodeResolve(id, parent, isMain, options)
      }
      const resolved = tryNodeResolve(id, parent.id, resolveOptions, false)
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
