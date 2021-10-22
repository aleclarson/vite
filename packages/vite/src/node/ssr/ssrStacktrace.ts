import { codeFrameColumns, SourceLocation } from '@babel/code-frame'
import { SourceMapConsumer, RawSourceMap } from 'source-map'
import { ModuleGraph } from '../server/moduleGraph'
import os from 'os'
import fs from 'fs'

const stackFrameRE = /^ {4}at (?:(.+?)\s+\()?(?:(.+?):(\d+)(?::(\d+))?)\)?/

export function ssrRewriteStacktrace(
  error: Error & { code?: unknown; errors?: any[]; originalStack?: string },
  moduleGraph: ModuleGraph,
  filter?: (source: string) => boolean
): void {
  if (error.code == 'MODULE_NOT_FOUND') return
  if (error.originalStack) return

  let stack = error.stack!
  Object.defineProperty(error, 'originalStack', {
    value: stack,
    configurable: true
  })

  let errorType = error.constructor.name
  if (!stack.startsWith(errorType)) {
    errorType = stack.slice(0, stack.indexOf(':'))
  }

  const header = errorType + ': ' + error.message + '\n'
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

  // Avoid mangling the stack trace if something goes wrong.
  if (!stackFrameRE.test(stack)) {
    return
  }

  // Prepend the syntax frame.
  if (syntaxFrame) {
    stack = `    at ${syntaxFrame}\n${stack}`
  }

  let code!: string
  let location: SourceLocation | undefined

  const removedFrames: number[] = []
  const stackFrames = stack.split('\n').map((line, i) =>
    line.replace(stackFrameRE, (input, varName, url, line, column) => {
      if (!url) return input

      const mod =
        moduleGraph.urlToModuleMap.get(url) ||
        moduleGraph.idToModuleMap.get(url)

      const rawSourceMap = mod?.ssrTransformResult?.map

      if (rawSourceMap) {
        const consumer = new SourceMapConsumer(
          rawSourceMap as unknown as RawSourceMap
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
      } else if (filter?.(url) === false) {
        removedFrames.push(i)
        return input
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

  removedFrames.reverse().forEach((i) => {
    stackFrames.splice(i, 1)
  })

  const message = location
    ? codeFrameColumns(code, location, {
        highlightCode: true,
        // ESBuild errors have the raw message in the `errors` array.
        message: error.errors ? error.errors[0].text : error.message
      })
    : error.message

  stack = message + '\n\n' + stackFrames.join('\n')
  rebindErrorStacktrace(error, stack)
}

function rebindErrorStacktrace(
  e: Error & { originalStack?: string },
  stacktrace: string
): void {
  const stack = Object.getOwnPropertyDescriptor(e, 'stack')!
  if (stack.configurable) {
    Object.defineProperty(e, 'stack', {
      value: stacktrace,
      enumerable: true,
      configurable: true,
      writable: true
    })
  } else if (stack.writable) {
    e.stack = stacktrace
  }
}
