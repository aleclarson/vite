import path from 'path'
import { promises as fs } from 'fs'
import { Logger } from '../logger'
import { createDebugger } from '../utils'
import { ModuleGraph } from './moduleGraph'

const isDebug = !!process.env.DEBUG
const debug = createDebugger('vite:sourcemap', {
  onlyWhenFocused: true
})

interface SourceMapLike {
  sources: string[]
  sourcesContent?: (string | null)[]
  sourceRoot?: string
}

export async function injectSourcesContent(
  map: SourceMapLike,
  file: string | null,
  logger: Logger,
  moduleGraph?: ModuleGraph
): Promise<void> {
  let sourceRoot: string | undefined
  if (file) {
    try {
      // The source root is undefined for virtual modules and permission errors.
      sourceRoot = await fs.realpath(
        path.resolve(path.dirname(file), map.sourceRoot || '')
      )
    } catch {}
  }

  const needsContent = !map.sourcesContent
  if (needsContent) {
    map.sourcesContent = []
  }

  const missingSources: string[] = []
  await Promise.all(
    map.sources.map(async (sourcePath, i) => {
      if (!sourcePath) return

      const source =
        sourcePath[0] === '/'
          ? moduleGraph?.urlToModuleMap.get(sourcePath)
          : undefined

      if (source) {
        if (!source.file) return
        sourcePath = source.file
      } else if (sourceRoot) {
        sourcePath = path.resolve(sourceRoot, decodeURI(sourcePath))
      }

      map.sources[i] = sourcePath
      if (needsContent) {
        try {
          map.sourcesContent![i] = await fs.readFile(sourcePath, 'utf-8')
        } catch {
          missingSources.push(sourcePath)
        }
      }
    })
  )

  // Use this command…
  //    DEBUG="vite:sourcemap" vite build
  // …to log the missing sources.
  if (missingSources.length) {
    logger.warnOnce(`Sourcemap for "${file}" points to missing source files`)
    isDebug && debug(`Missing sources:\n  ` + missingSources.join(`\n  `))
  }
}
