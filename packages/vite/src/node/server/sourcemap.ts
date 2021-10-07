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
  file: string,
  logger: Logger,
  moduleGraph?: ModuleGraph
): Promise<void> {
  let sourceRoot: string | undefined
  try {
    // The source root is undefined for virtual modules and permission errors.
    sourceRoot = await fs.realpath(
      path.resolve(path.dirname(file), map.sourceRoot || '')
    )
  } catch {}

  const needsContent = !map.sourcesContent
  if (needsContent) {
    map.sourcesContent = []
  }

  const missingSources: string[] = []
  await Promise.all(
    map.sources.map(async (sourcePath, i) => {
      if (sourcePath) {
        const mod = moduleGraph?.urlToModuleMap.get(sourcePath)
        if (mod?.file) {
          sourcePath = mod.file
        } else if (sourceRoot) {
          sourcePath = path.resolve(sourceRoot, decodeURI(sourcePath))
        }
        if (moduleGraph) {
          map.sources[i] = sourcePath
        }
        if (needsContent) {
          try {
            map.sourcesContent![i] = await fs.readFile(sourcePath, 'utf-8')
          } catch {
            missingSources.push(sourcePath)
          }
        }
      }
      return null
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
