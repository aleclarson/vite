import os from 'os'
import fs from 'fs'
import path from 'path'
import { codeFrameColumns, SourceLocation } from '@babel/code-frame'
import { SourceMapConsumer, RawSourceMap, Position } from 'source-map'
import * as convertSourceMap from 'convert-source-map'
import { ModuleGraph } from '../server/moduleGraph'

const stackFrameRE = /^ {4}at (?:(.+?)\s+\()?(?:(.+?):(\d+)(?::(\d+))?)\)?/

interface SSRError extends Error {
  code?: unknown
  errors?: any[]
  originalStack?: string
  file?: string
  loc?: Position & { file?: string }
}

export function ssrRewriteStacktrace(
  error: SSRError,
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
  if (error.loc || error.errors?.[0].location) {
    const loc = error.loc || error.errors![0].location
    const { file = error.file, line, column } = loc
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

  let failedScript!: string
  let location: SourceLocation | undefined

  const removedFrames: number[] = []
  const stackFrames = stack.split('\n').map((line, i) =>
    line.replace(stackFrameRE, (input, varName, url, line, column) => {
      if (!url) return input

      // Grab the source map from Vite's module graph.
      const mod =
        moduleGraph.urlToModuleMap.get(url) ||
        moduleGraph.idToModuleMap.get(url)

      let code: string | undefined
      let filename = mod?.file
      let rawSourceMap = mod?.ssrTransformResult?.map as
        | RawSourceMap
        | undefined

      // If no module node exists, this source is likely a third-party module,
      // so we need to load its source map from disk.
      if (!mod) {
        try {
          code = fs.readFileSync(url, 'utf8')
          filename = url
          rawSourceMap = (
            convertSourceMap.fromSource(code) ||
            convertSourceMap.fromMapFileSource(code, path.dirname(url))
          )?.toObject()
        } catch {}
      }

      if (rawSourceMap) {
        const consumer = new SourceMapConsumer(rawSourceMap)
        const pos = consumer.originalPositionFor({
          line: Number(line),
          column: Number(column),
          bias: SourceMapConsumer.GREATEST_LOWER_BOUND
        })

        if (pos.source) {
          url = pos.source
          line = pos.line
          column = pos.column

          const sourceRoot =
            rawSourceMap.sourceRoot || (filename && path.dirname(filename))
          if (sourceRoot) {
            url = path.resolve(sourceRoot, url)
          }
        }
      }

      if (i == 0 && filename) {
        error.file = filename
        failedScript = code || fs.readFileSync(filename, 'utf8')
        location = {
          start: {
            line: Number(line),
            column: Number(column + 1)
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

  if (location) {
    error.message = codeFrameColumns(failedScript, location, {
      highlightCode: true,
      // ESBuild errors have the raw message in the `errors` array.
      message: error.errors ? error.errors[0].text : error.message
    })
  }

  stack = error.message + '\n\n' + stackFrames.join('\n')
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
