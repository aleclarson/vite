import { relative } from 'path'
import { normalizePath } from '@rollup/pluginutils'
import { ResolvedConfig } from '..'
import { Plugin } from '../plugin'

export function ssrManifestPlugin(config: ResolvedConfig): Plugin {
  // module id => preload assets mapping
  const ssrManifest: Record<string, string[]> = {}
  const base = config.base

  return {
    name: 'vite:ssr-manifest',
    generateBundle(_options, bundle) {
      for (const file in bundle) {
        const chunk = bundle[file]
        if (chunk.type === 'chunk') {
          for (const id in chunk.modules) {
            const normalizedId = normalizePath(relative(config.root, id))
            const mappedChunks =
              ssrManifest[normalizedId] || (ssrManifest[normalizedId] = [])
            if (!chunk.isEntry) {
              mappedChunks.push(base + chunk.fileName)
              // <link> tags for entry chunks are already generated in static HTML,
              // so we only need to record info for non-entry chunks.
              chunk.importedCss.forEach((file) => {
                mappedChunks.push(base + file)
              })
            }
            chunk.importedAssets.forEach((file) => {
              mappedChunks.push(base + file)
            })
          }
        }
      }

      this.emitFile({
        fileName: 'ssr-manifest.json',
        type: 'asset',
        source: JSON.stringify(ssrManifest, null, 2)
      })
    }
  }
}
