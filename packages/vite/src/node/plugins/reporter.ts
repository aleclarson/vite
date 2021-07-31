import path from 'path'
import chalk from 'chalk'
import { gzip } from 'zlib'
import { promisify } from 'util'
import { startTask, MistyTask } from 'misty/task'
import { Plugin } from 'rollup'
import { ResolvedConfig } from '../config'
import { normalizePath } from '../utils'
import { LogLevels } from '../logger'

const enum WriteType {
  JS,
  CSS,
  ASSET,
  HTML,
  SOURCE_MAP
}

const writeColors = {
  [WriteType.JS]: chalk.cyan,
  [WriteType.CSS]: chalk.magenta,
  [WriteType.ASSET]: chalk.green,
  [WriteType.HTML]: chalk.blue,
  [WriteType.SOURCE_MAP]: chalk.gray
}

export function buildReporterPlugin(config: ResolvedConfig): Plugin {
  const compress = promisify(gzip)
  const chunkLimit = config.build.chunkSizeWarningLimit

  function isLarge(code: string | Uint8Array): boolean {
    // bail out on particularly large chunks
    return code.length / 1024 > chunkLimit
  }

  async function getCompressedSize(code: string | Uint8Array): Promise<string> {
    if (
      config.build.ssr ||
      !config.build.reportCompressedSize ||
      config.build.brotliSize === false
    ) {
      return ''
    }
    return ` / gzip: ${(
      (await compress(typeof code === 'string' ? code : Buffer.from(code)))
        .length / 1024
    ).toFixed(2)} KiB`
  }

  function printFileInfo(
    filePath: string,
    content: string | Uint8Array,
    type: WriteType,
    maxLength: number,
    compressedSize = ''
  ) {
    const outDir =
      normalizePath(
        path.relative(
          config.root,
          path.resolve(config.root, config.build.outDir)
        )
      ) + '/'
    const kibs = content.length / 1024
    const sizeColor = kibs > chunkLimit ? chalk.yellow : chalk.dim
    config.logger.info(
      `${chalk.gray(chalk.white.dim(outDir))}${writeColors[type](
        filePath.padEnd(maxLength + 2)
      )} ${sizeColor(`${kibs.toFixed(2)} KiB${compressedSize}`)}`
    )
  }

  const tty = process.stdout.isTTY && !process.env.CI
  const shouldLogInfo = LogLevels[config.logLevel || 'info'] >= LogLevels.info
  let transformedCount = 0
  let chunkCount = 0

  let transformTask: MistyTask | undefined
  let renderChunksTask: MistyTask | undefined

  return {
    name: 'vite:reporter',

    transform(_, id) {
      transformedCount++
      if (shouldLogInfo) {
        transformTask ??= startTask(`transforming...`)
        if (tty && !id.includes('?')) {
          transformTask.update(
            `transforming (${transformedCount}) ${chalk.dim(
              path.relative(config.root, id)
            )}`
          )
        }
      }
      return null
    },

    buildEnd() {
      if (shouldLogInfo) {
        transformTask?.finish(`${transformedCount} modules transformed.`)
      }
    },

    renderStart() {
      chunkCount = 0
    },

    renderChunk() {
      chunkCount++
      if (shouldLogInfo) {
        renderChunksTask ??= startTask(`rendering chunks...`)
        tty && renderChunksTask.update(`rendering chunks (${chunkCount})...`)
      }
      return null
    },

    generateBundle() {
      if (shouldLogInfo) {
        renderChunksTask?.finish(`${chunkCount} chunks rendered.`)
      }
    },

    async writeBundle(_, output) {
      let hasLargeChunks = false

      if (shouldLogInfo) {
        let longest = 0
        for (const file in output) {
          const l = output[file].fileName.length
          if (l > longest) longest = l
        }

        // large chunks are deferred to be logged at the end so they are more
        // visible.
        const deferredLogs: (() => void)[] = []

        await Promise.all(
          Object.keys(output).map(async (file) => {
            const chunk = output[file]
            if (chunk.type === 'chunk') {
              const log = async () => {
                printFileInfo(
                  chunk.fileName,
                  chunk.code,
                  WriteType.JS,
                  longest,
                  await getCompressedSize(chunk.code)
                )
                if (chunk.map) {
                  printFileInfo(
                    chunk.fileName + '.map',
                    chunk.map.toString(),
                    WriteType.SOURCE_MAP,
                    longest
                  )
                }
              }
              if (isLarge(chunk.code)) {
                hasLargeChunks = true
                deferredLogs.push(log)
              } else {
                await log()
              }
            } else if (chunk.source) {
              const isCSS = chunk.fileName.endsWith('.css')
              printFileInfo(
                chunk.fileName,
                chunk.source,
                isCSS ? WriteType.CSS : WriteType.ASSET,
                longest,
                isCSS ? await getCompressedSize(chunk.source) : undefined
              )
            }
          })
        )

        await Promise.all(deferredLogs.map((l) => l()))
      } else {
        hasLargeChunks = Object.keys(output).some((file) => {
          const chunk = output[file]
          return chunk.type === 'chunk' && chunk.code.length / 1024 > chunkLimit
        })
      }

      if (
        hasLargeChunks &&
        config.build.minify &&
        !config.build.lib &&
        !config.build.ssr
      ) {
        config.logger.warn(
          chalk.yellow(
            `\n(!) Some chunks are larger than ${chunkLimit} KiB after minification. Consider:\n` +
              `- Using dynamic import() to code-split the application\n` +
              `- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/guide/en/#outputmanualchunks\n` +
              `- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.`
          )
        )
      }
    }
  }
}
