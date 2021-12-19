import * as esbuild from 'esbuild'
import { ResolvedConfig } from '../config'
import { prettifyMessage } from '../plugins/esbuild'
import { ModuleGraph } from '../server/moduleGraph'
import { createPluginContainer } from '../server/pluginContainer'
import { isObject } from '../utils'

export interface NitroBuildOptions {
  external?: string[]
}

export async function nitroBuild(config: ResolvedConfig) {
  const options = isObject(config.build.nitro) ? config.build.nitro : {}

  const moduleGraph: ModuleGraph = new ModuleGraph((url) =>
    container.resolveId(url)
  )

  const container = await createPluginContainer(config, moduleGraph)

  const resolver: esbuild.Plugin = {
    name: 'vite:nitro',
    setup(build) {
      build.onStart(() => container.buildStart({}))
      build.onEnd(() => container.close())
    }
  }

  const built = await esbuild.build({
    entryPoints: [],
    external: options.external,
    plugins: [resolver],
    bundle: true,
    write: false
  })
}
