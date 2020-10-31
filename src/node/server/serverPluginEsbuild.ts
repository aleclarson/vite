import LRUCache from 'lru-cache'
import { ServerPlugin } from '.'
import {
  tjsxRE,
  transform,
  resolveJsxOptions,
  vueJsxPublicPath,
  vueJsxFilePath
} from '../esbuildService'
import { readBody, cleanUrl } from '../utils'

// #985: silence logs when etag hasn't changed in past 30 seconds
const etagCache = new LRUCache({ maxAge: 3e4 })

export const esbuildPlugin: ServerPlugin = ({ app, config, resolver }) => {
  const jsxConfig = resolveJsxOptions(config.jsx)

  app.use(async (ctx, next) => {
    // intercept and return vue jsx helper import
    if (ctx.path === vueJsxPublicPath) {
      await ctx.read(vueJsxFilePath)
    }

    await next()

    if (
      !tjsxRE.test(ctx.path) ||
      !ctx.body ||
      ctx.type === 'text/html' ||
      resolver.isPublicRequest(ctx.path)
    ) {
      return
    }

    ctx.type = 'js'
    const src = await readBody(ctx.body)
    const { code, map } = await transform(
      src!,
      resolver.requestToFile(cleanUrl(ctx.url)),
      jsxConfig,
      config.jsx,
      // silent when etag is unchanged
      ctx.etag === etagCache.get(ctx.path)
    )
    etagCache.set(ctx.path, ctx.etag)
    ctx.body = code
    if (map) {
      ctx.map = JSON.parse(map)
    }
  })
}
