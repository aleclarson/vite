import chokidar from 'chokidar'
import type { FSWatcher, WatchOptions } from '../../types/chokidar'
import type { ResolvedConfig } from './config'
import { ModuleGraph } from './server/moduleGraph'
import type { PluginContainer } from './server/pluginContainer'
import { createPluginContainer } from './server/pluginContainer'
import type { TransformResult } from './server/transformRequest'
import { isObject } from './utils'

export interface TransformContext {
  config: ResolvedConfig
  watcher: FSWatcher | null
  moduleGraph: ModuleGraph
  pluginContainer: PluginContainer
  pendingRequests: Map<string, Promise<TransformResult | null>>
}

export async function createTransformContext(
  config: ResolvedConfig,
  watch?: WatchOptions | boolean
): Promise<TransformContext> {
  const watcher =
    watch !== false
      ? createWatcher(config.root, isObject(watch) ? watch : {})
      : null

  const moduleGraph: ModuleGraph = new ModuleGraph((url) =>
    pluginContainer.resolveId(url)
  )

  const pluginContainer = await createPluginContainer(
    config,
    moduleGraph,
    watcher
  )

  return {
    config,
    watcher,
    moduleGraph,
    pluginContainer,
    pendingRequests: new Map()
  }
}

function createWatcher(root: string, watchOptions: WatchOptions = {}) {
  const { ignored = [] } = watchOptions
  return chokidar.watch(root, {
    ignoreInitial: true,
    ignorePermissionErrors: true,
    disableGlobbing: true,
    ...watchOptions,
    followSymlinks: false,
    ignored: [
      '**/node_modules/**',
      '**/.git/**',
      ...(Array.isArray(ignored) ? ignored : [ignored])
    ]
  }) as FSWatcher
}
