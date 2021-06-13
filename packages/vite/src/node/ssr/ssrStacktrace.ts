import { SourceMapConsumer, RawSourceMap } from 'source-map'
import { ModuleGraph } from '../server/moduleGraph'

export function ssrRewriteStacktrace(
  stack: string,
  moduleGraph: ModuleGraph
): string {
  return stack
    .split('\n')
    .map((line) => {
      return line.replace(
        /^ {4}at (?:(.+?)\s+\()?(?:(.+?):(\d+)(?::(\d+))?)\)?/,
        (input, varName, url, line, column) => {
          if (!url) return input

          const mod = moduleGraph.urlToModuleMap.get(url)
          const rawSourceMap = mod?.ssrTransformResult?.map

          if (!rawSourceMap) {
            return input
          }

          const consumer = new SourceMapConsumer(
            rawSourceMap as unknown as RawSourceMap
          )

          const pos = consumer.originalPositionFor({
            line: Number(line),
            column: Number(column),
            bias: SourceMapConsumer.LEAST_UPPER_BOUND
          })

          if (!pos.source) {
            return input
          }

          const source = `${pos.source}:${pos.line || 0}:${pos.column || 0}`
          if (!varName || varName === 'eval') {
            return `    at ${source}`
          } else {
            return `    at ${varName} (${source})`
          }
        }
      )
    })
    .join('\n')
}

export function rebindErrorStacktrace(e: Error, stacktrace: string): void {
  const { configurable, writable } = Object.getOwnPropertyDescriptor(
    e,
    'stack'
  )!
  if (configurable) {
    Object.defineProperty(e, 'stack', {
      value: stacktrace,
      enumerable: true,
      configurable: true,
      writable: true
    })
  } else if (writable) {
    e.stack = stacktrace
  }
}
