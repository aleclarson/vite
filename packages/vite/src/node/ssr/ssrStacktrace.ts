import { codeFrameColumns, SourceLocation } from '@babel/code-frame'
import { SourceMapConsumer, RawSourceMap } from 'source-map'
import { ModuleGraph } from '../server/moduleGraph'
import os from 'os'
import fs from 'fs'

const stackFrameRE = /^ {4}at (?:(.+?)\s+\()?(?:(.+?):(\d+)(?::(\d+))?)\)?/

export function ssrRewriteStacktrace(
  error: Error & { errors?: any[] },
  moduleGraph: ModuleGraph
): string {
  let code!: string
  let location: SourceLocation | undefined
  let stack = error.stack!

  const header = error.constructor.name + ': ' + error.message + '\n'
  const headerIndex = stack.indexOf(header)

  let syntaxFrame: string | undefined
  if (error.errors?.[0].location) {
    const { file, line, column } = error.errors[0].location
    const mod = moduleGraph.getModuleById(file)
    syntaxFrame = (mod ? mod.url : file) + ':' + line + ':' + (column + 1)
  } else {
    const locationRE = new RegExp(
      '(^|\\s)' +
        os.homedir().replace(/\\/g, '\\\\') +
        '([\\\\/][^:]+)*:\\d+(:\\d+)?'
    )
    const match = locationRE.exec(stack)
    if (match && match.index < headerIndex) {
      syntaxFrame = match[0].trim()
    }
  }

  // Strip the error message.
  stack = stack.slice(headerIndex + header.length)

  // If something else comes after the error message,
  // then we probably already processed this stack trace.
  if (!stackFrameRE.test(stack)) {
    return error.stack!
  }

  // Prepend the syntax frame.
  if (syntaxFrame) {
    stack = `    at ${syntaxFrame}\n${stack}`
  }

  const stackFrames = stack.split('\n').map((line, i) =>
    line.replace(stackFrameRE, (input, varName, url, line, column) => {
      if (!url) return input

      const mod = moduleGraph.urlToModuleMap.get(url)
      const rawSourceMap = mod?.ssrTransformResult?.map

      if (rawSourceMap) {
        const consumer = new SourceMapConsumer(
          rawSourceMap as any as RawSourceMap
        )

        const pos = consumer.originalPositionFor({
          line: Number(line),
          column: Number(column),
          bias: SourceMapConsumer.GREATEST_LOWER_BOUND
        })

        if (pos.source) {
          url = pos.source
          line = pos.line
          column = pos.column
        }
      }

      if (i == 0 && mod?.file) {
        code = fs.readFileSync(mod.file, 'utf8')
        location = {
          start: {
            line: Number(line),
            column: Number(column)
          }
        }
      }

      if (rawSourceMap) {
        const source = `${url}:${line}:${column}`
        if (!varName || varName === 'eval') {
          return `    at ${source}`
        } else {
          return `    at ${varName} (${source})`
        }
      }
      return input
    })
  )

  const message = location
    ? codeFrameColumns(code, location, {
        highlightCode: true,
        // ESBuild errors have the raw message in the `errors` array.
        message: error.errors ? error.errors[0].text : error.message
      })
    : error.message

  return message + '\n\n' + stackFrames.join('\n')
}
