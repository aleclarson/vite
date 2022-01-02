import type { ParserOptions, TransformOptions, types as t } from '@babel/core'
import * as babel from '@babel/core'
import { createFilter } from '@rollup/pluginutils'
import resolve from 'resolve'
import type { Plugin, PluginOption } from 'vite'
import {
  addRefreshWrapper,
  isRefreshBoundary,
  preambleCode,
  runtimeCode,
  runtimePublicPath
} from './fast-refresh'
import { babelImportToRequire } from './jsx-runtime/babel-import-to-require'
import { restoreJSX } from './jsx-runtime/restore-jsx'
import { findCompilerOption } from './tsconfig'

declare module 'vite' {
  export interface Plugin {
    /**
     * Babel configuration applied in both dev and prod.
     */
    babel?: Pick<TransformOptions, 'plugins' | 'presets'>
  }
}

export interface Options {
  include?: string | RegExp | Array<string | RegExp>
  exclude?: string | RegExp | Array<string | RegExp>
  /**
   * Enable `react-refresh` integration. Vite disables this in prod env or build mode.
   * @default true
   */
  fastRefresh?: boolean
  /**
   * Set this to `"automatic"` to use [vite-react-jsx](https://github.com/alloc/vite-react-jsx).
   * @default "automatic"
   */
  jsxRuntime?: 'classic' | 'automatic'
  /**
   * Control where the JSX factory is imported from.
   * This option is ignored when `jsxRuntime` is not `"automatic"`.
   * @default "react"
   */
  jsxImportSource?: string
  /**
   * Enable decorator syntax proposal.
   * @see https://babeljs.io/docs/en/babel-plugin-proposal-decorators
   */
  decorators?: { legacy: true } | { beforeExport: boolean }
  /**
   * Babel configuration applied in both dev and prod.
   */
  babel?: TransformOptions
  /**
   * @deprecated Use `babel.parserOpts.plugins` instead
   */
  parserPlugins?: ParserOptions['plugins']
}

const prodRuntimeId = 'react/jsx-runtime'
const devRuntimeId = 'react/jsx-dev-runtime'

export default function viteReact(opts: Options = {}): PluginOption[] {
  // Provide default values for Rollup compat.
  let base = '/'
  let filter = createFilter(opts.include, opts.exclude)
  let isProduction = true
  let projectRoot = process.cwd()
  let skipFastRefresh = opts.fastRefresh === false
  let skipReactImport = false

  const useAutomaticRuntime = opts.jsxRuntime !== 'classic'

  let userPlugins = [...(opts.babel?.plugins || [])]
  let userPresets = [...(opts.babel?.presets || [])]

  const userParserPlugins =
    opts.parserPlugins || opts.babel?.parserOpts?.plugins || []

  // Shortcut for enabling decorator syntax.
  if (opts.decorators) {
    userParserPlugins.push(
      'legacy' in opts.decorators
        ? 'decorators-legacy'
        : [
            'decorators',
            { decoratorsBeforeExport: opts.decorators.beforeExport }
          ]
    )
  }

  const importReactRE = /(^|\n)import\s+(\*\s+as\s+)?React\s+/

  const viteBabel: Plugin = {
    name: 'vite:react-babel',
    enforce: 'pre',
    configResolved(config) {
      base = config.base
      projectRoot = config.root
      filter = createFilter(opts.include, opts.exclude, {
        resolve: projectRoot
      })
      isProduction = config.isProduction
      skipFastRefresh ||= isProduction || config.command === 'build'

      const jsxInject = config.esbuild && config.esbuild.jsxInject
      if (jsxInject && importReactRE.test(jsxInject)) {
        skipReactImport = true
        config.logger.warn(
          '[@vitejs/plugin-react] This plugin imports React for you automatically,' +
            ' so you can stop using `esbuild.jsxInject` for that purpose.'
        )
      }

      config.plugins.forEach((plugin) => {
        const isExtraneous =
          plugin.name === 'react-refresh' ||
          (plugin !== viteReactJsx && plugin.name === 'vite:react-jsx')

        if (isExtraneous)
          return config.logger.warn(
            `[@vitejs/plugin-react] You should stop using "${plugin.name}" ` +
              `since this plugin conflicts with it.`
          )

        if (plugin.babel) {
          const { plugins, presets } = plugin.babel
          if (plugins) {
            userPlugins =
              plugin.enforce === 'pre'
                ? [...plugins, ...userPlugins]
                : [...userPlugins, ...plugins]
          }
          if (presets) {
            userPresets =
              plugin.enforce === 'pre'
                ? [...presets, ...userPresets]
                : [...userPresets, ...presets]
          }
        }
      })
    },
    async transform(code, id, ssr) {
      if (/\.(mjs|[tj]sx?)$/.test(id)) {
        const moduleInfo = this.getModuleInfo(id)!
        const isNodeModules = id.includes('/node_modules/')
        const isProjectFile =
          !moduleInfo.meta.filename ||
          (id.startsWith(projectRoot + '/') && !isNodeModules)

        let plugins = isProjectFile ? [...userPlugins] : []

        let useFastRefresh = false
        if (!skipFastRefresh && !ssr && !isNodeModules) {
          // Modules with .js or .ts extension must import React.
          const isReactModule = id.endsWith('x') || code.includes('react')
          if (isReactModule && filter(id)) {
            useFastRefresh = true
            plugins.push([
              await loadPlugin('react-refresh/babel.js'),
              { skipEnvCheck: true }
            ])
          }
        }

        let ast: t.File | null | undefined
        if (!isProjectFile || id.endsWith('x')) {
          if (useAutomaticRuntime) {
            // By reverse-compiling "React.createElement" calls into JSX,
            // React elements provided by dependencies will also use the
            // automatic runtime!
            const [restoredAst, isCommonJS] = !isProjectFile
              ? await restoreJSX(babel, code, id)
              : [null, false]

            if (isProjectFile || (ast = restoredAst)) {
              plugins.push([
                await loadPlugin(
                  '@babel/plugin-transform-react-jsx' +
                    (isProduction ? '' : '-development')
                ),
                {
                  runtime: 'automatic',
                  importSource: opts.jsxImportSource
                }
              ])

              // Avoid inserting `import` statements into CJS modules.
              if (isCommonJS) {
                plugins.push(babelImportToRequire)
              }
            }
          } else if (isProjectFile) {
            // These plugins are only needed for the classic runtime.
            if (!isProduction) {
              plugins.push(
                await loadPlugin('@babel/plugin-transform-react-jsx-self'),
                await loadPlugin('@babel/plugin-transform-react-jsx-source')
              )
            }

            // Even if the automatic JSX runtime is not used, we can still
            // inject the React import for .jsx and .tsx modules.
            if (!skipReactImport && !importReactRE.test(code)) {
              code = `import React from 'react'; ` + code
            }
          }
        }

        // Plugins defined through this Vite plugin are only applied
        // to modules within the project root, but "babel.config.js"
        // files can define plugins that need to be applied to every
        // module, including node_modules and linked packages.
        const shouldSkip =
          !plugins.length &&
          !opts.babel?.configFile &&
          !(isProjectFile && (userPresets.length || opts.babel?.babelrc))

        if (shouldSkip) {
          return // Avoid parsing if no plugins exist.
        }

        const parserPlugins: typeof userParserPlugins = [
          ...userParserPlugins,
          'importMeta',
          // This plugin is applied before esbuild transforms the code,
          // so we need to enable some stage 3 syntax that is supported in
          // TypeScript and some environments already.
          'topLevelAwait',
          'classProperties',
          'classPrivateProperties',
          'classPrivateMethods'
        ]

        if (!id.endsWith('.ts')) {
          parserPlugins.push('jsx')
        }

        if (/\.tsx?$/.test(id)) {
          parserPlugins.push('typescript')
          if (findCompilerOption(id, 'experimentalDecorators')) {
            parserPlugins.push('decorators-legacy')
          }
        }

        const isReasonReact = id.endsWith('.bs.js')

        const babelOpts: TransformOptions = {
          babelrc: false,
          configFile: false,
          ...opts.babel,
          ast: !isReasonReact,
          root: projectRoot,
          filename: id,
          sourceFileName: id,
          parserOpts: {
            ...opts.babel?.parserOpts,
            sourceType: 'module',
            allowAwaitOutsideFunction: true,
            plugins: parserPlugins
          },
          generatorOpts: {
            ...opts.babel?.generatorOpts,
            decoratorsBeforeExport: true
          },
          plugins,
          presets: isProjectFile ? userPresets : [],
          sourceMaps: true,
          // Vite handles sourcemap flattening
          inputSourceMap: false as any
        }

        const result = ast
          ? await babel.transformFromAstAsync(ast, code, babelOpts)
          : await babel.transformAsync(code, babelOpts)

        if (result?.map) {
          result.map.sourcesContent = [code]
        }

        if (result) {
          let code = result.code!
          if (useFastRefresh && /\$RefreshReg\$\(/.test(code)) {
            const accept = isReasonReact || isRefreshBoundary(result.ast!)
            code = addRefreshWrapper(code, id, accept)
          }
          return {
            code,
            map: result.map
          }
        }
      }
    }
  }

  const viteReactRefresh: Plugin = {
    name: 'vite:react-refresh',
    enforce: 'pre',
    config: () => ({
      resolve: {
        dedupe: ['react', 'react-dom']
      }
    }),
    resolveId(id) {
      if (id === runtimePublicPath) {
        return id
      }
    },
    load(id) {
      if (id === runtimePublicPath) {
        return runtimeCode
      }
    },
    transformIndexHtml() {
      if (!skipFastRefresh)
        return [
          {
            tag: 'script',
            attrs: { type: 'module' },
            children: preambleCode.replace(`__BASE__`, base)
          }
        ]
    }
  }

  const runtimeDep = '\0:node_modules:' + prodRuntimeId

  // Adapted from https://github.com/alloc/vite-react-jsx
  const viteReactJsx: Plugin = {
    name: 'vite:react-jsx',
    enforce: 'pre',
    config() {
      return {
        optimizeDeps: {
          include: [prodRuntimeId, devRuntimeId]
        }
      }
    },
    resolveId(id: string) {
      // Include "node_modules" in the resolved `id` to ensure its module is
      // added to the vendor chunk.
      return id === prodRuntimeId || id === devRuntimeId ? runtimeDep : null
    },
    load(id: string) {
      if (id === runtimeDep) {
        let runtimePath = `react/cjs/react-jsx-${
          isProduction ? 'runtime.production.min' : 'dev-runtime.development'
        }.js`
        runtimePath = resolve.sync(runtimePath, {
          basedir: projectRoot
        })
        // We can't use `export * from` or else any callsite that uses
        // this module will be compiled to `jsxRuntime.exports.jsx`
        // instead of the more concise `jsx` alias.
        const lines = [
          `import * as jsxRuntime from ${JSON.stringify(runtimePath)}`,
          `export const Fragment = jsxRuntime.Fragment`
        ]
        for (const prodId of ['jsx', 'jsxs']) {
          const importedId = isProduction ? prodId : prodId + 'DEV'
          lines.push(`export const ${importedId} = jsxRuntime.${importedId}`)
          if (!isProduction) {
            // Ensure production exports exist in development mode.
            lines.push(`export const ${prodId} = jsxRuntime.${importedId}`)
          }
        }
        return lines.join('\n')
      }
    }
  }

  return [viteBabel, viteReactRefresh, useAutomaticRuntime && viteReactJsx]
}

viteReact.preambleCode = preambleCode

function loadPlugin(path: string): Promise<any> {
  return import(path).then((module) => module.default || module)
}

// overwrite for cjs require('...')() usage
module.exports = viteReact
viteReact['default'] = viteReact
