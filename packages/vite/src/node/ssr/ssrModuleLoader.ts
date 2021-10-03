import vm from 'vm'
import path from 'path'
import { Module } from 'module'
import * as convertSourceMap from 'convert-source-map'
import { ViteDevServer } from '..'
import { lookupFile, unwrapId } from '../utils'
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
import {
  InternalResolveOptions,
  loadPackageData,
  tryNodeResolve
} from '../plugins/resolve'
import { hookNodeResolve } from '../plugins/ssrRequireHook'
import { createSSRExternalsFilter } from './ssrExternal'

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
      if (!e.originalStack) {
        try {
          ssrRewriteStacktrace(e, server.moduleGraph)
        } catch {}
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

  const isExternal = createSSRExternalsFilter(
    server._ssrExternals!,
    server.config.ssr?.noExternal
  )

  // Since dynamic imports can happen in parallel, we need to
  // account for multiple pending deps and duplicate imports.
  const pendingDeps: string[] = []

  const ssrImport = async (dep: string) => {
    if (server._pendingReload) {
      // Wait for "server._ssrExternals" to be updated
      await server._pendingReload
    }
    if (dep[0] !== '/' && isExternal(dep)) {
      return nodeRequire(dep, filename, resolveOptions)
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

  return Object.freeze(ssrModule)
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
