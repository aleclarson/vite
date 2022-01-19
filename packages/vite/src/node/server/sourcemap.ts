import convertSourceMap from 'convert-source-map'
import { promises as fs } from 'fs'
import path from 'path'
import { SourceMap } from 'rollup'
import { Logger } from '../logger'
import type { SymlinkResolver } from '../symlinks'
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
  symlinkResolver: SymlinkResolver,
  moduleGraph?: ModuleGraph
): Promise<void> {
  let sourceRoot: string | undefined
  if (file) {
    try {
      // The source root is undefined for virtual modules and permission errors.
      sourceRoot = symlinkResolver.realpathSync(
        path.resolve(path.dirname(file), map.sourceRoot || '')
      )
    } catch {}
  }

  const sourcesContent = (map.sourcesContent ||= [])
  const missingSources: string[] = []
  await Promise.all(
    map.sources.map(async (sourcePath, i) => {
      if (!sourcePath) return

      const source =
        sourcePath[0] === '/'
          ? moduleGraph?.urlToModuleMap.get(sourcePath)
          : undefined

      map.sources[i] = sourcePath = source
        ? source.file
        : sourceRoot
        ? path.resolve(sourceRoot, decodeURI(sourcePath))
        : sourcePath

      if (!sourcesContent[i]) {
        // When meta.filename is undefined, assume the source is virtual.
        if (source && !source.meta?.filename) {
          missingSources.push(sourcePath)
          return
        }
        try {
          sourcesContent[i] = await fs.readFile(sourcePath, 'utf-8')
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

export function loadSourceMap(
  code: string,
  file: string,
  logger: Logger
): SourceMap | null {
  let converter = convertSourceMap.fromSource(code)
  try {
    converter = convertSourceMap.fromMapFileSource(code, path.dirname(file))
  } catch (e) {
    logger.warn(`Source map for "${file}" could not be loaded.`, {
      timestamp: true
    })
  }
  return converter?.toObject()
}
