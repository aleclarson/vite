import { build } from 'esbuild'
import type { ViteDevServer } from '..'

export function treeShakePlugin(server: ViteDevServer) {}

type Module = { id: string; code: string }

export class TreeShaking {
  moduleCache: { [source: string]: { [binding: string]: Promise<Module> } } = {}

  constructor(readonly server: ViteDevServer) {}

  async importFrom(source: string, binding: string) {
    const exports = this.moduleCache[source] || (this.moduleCache[source] = {})
    return (
      exports[binding] ||
      (exports[binding] = this.build({
        id: source + '?export=' + binding,
        code: `export { ${binding} } from "${source}"`
      }))
    )
  }

  private async build(input: Module) {
    const { outputFiles } = await build({
      entryPoints: [input.id],
      format: 'esm',
      target: 'esnext',
      write: false,
      bundle: true,
      // sourcemap: 'inline',
      // metafile: true,
      plugins: [
        {
          name: 'TreeShaking',
          setup: (build) => {
            build.onResolve({ filter: /.+/ }, (args) => {
              return {
                path: args.path,
                namespace: 'virtual',
                // Assume all function calls are pure.
                // Modules with side effects are not supported.
                sideEffects: false
              }
            })
            build.onLoad({ filter: /.+/ }, async (args) => {
              if (args.path === input.id) {
                return { loader: 'js', contents: input.code }
              }
              const transformResult = await this.server.transformRequest(
                args.path
              )
              const contents = transformResult?.code
              if (contents) {
                return { loader: 'tsx', contents }
              }
            })
          }
        }
      ]
    })

    return {
      id: input.id,
      code: outputFiles[0].text
    }
  }
}
