import fs from 'fs'
import path from 'path'
import { Plugin } from '../plugin'
import { ViteDevServer } from '../server'
import { OutputAsset, OutputBundle, OutputChunk } from 'rollup'
import { cleanUrl, isExternalUrl, isDataUrl, generateCodeFrame } from '../utils'
import { ResolvedConfig } from '../config'
import slash from 'slash'
import MagicString from 'magic-string'
import { checkPublicFile, assetUrlRE, urlToBuiltUrl } from './asset'
import { isCSSRequest, chunkToEmittedCssFileMap } from './css'
import { polyfillId } from './dynamicImportPolyfill'
import { AttributeNode, ElementNode, NodeTypes } from '@vue/compiler-dom'

const htmlProxyRE = /\?html-proxy&index=(\d+)\.js$/
export const isHTMLProxy = (id: string) => htmlProxyRE.test(id)
export const htmlCommentRE = /<!--[\s\S]*?-->/g
export const scriptModuleRE = /(<script\b[^>]*type\s*=\s*(?:"module"|'module')[^>]*>)([\s\S]*?)<\/script>/gm

export function htmlPlugin(): Plugin {
  return {
    name: 'vite:html',

    resolveId(id) {
      if (htmlProxyRE.test(id)) {
        return id
      }
    },

    load(id) {
      const proxyMatch = id.match(htmlProxyRE)
      if (proxyMatch) {
        const index = Number(proxyMatch[1])
        const file = cleanUrl(id)
        const html = fs.readFileSync(file, 'utf-8').replace(htmlCommentRE, '')
        let match
        scriptModuleRE.lastIndex = 0
        for (let i = 0; i <= index; i++) {
          match = scriptModuleRE.exec(html)
        }
        if (match) {
          return match[2]
        } else {
          throw new Error(`No matching html proxy module found from ${id}`)
        }
      }
    }
  }
}

// this extends the config in @vue/compiler-sfc with <link href>
const assetAttrsConfig: Record<string, string[]> = {
  link: ['href'],
  video: ['src', 'poster'],
  source: ['src'],
  script: ['src'],
  img: ['src'],
  image: ['xlink:href', 'href'],
  use: ['xlink:href', 'href']
}

/**
 * Compiles index.html into an entry js module
 */
export function buildHtmlPlugin(config: ResolvedConfig): Plugin {
  const [preHooks, postHooks] = resolveHtmlTransforms(config.plugins)
  const processedHtml = new Map<string, string>()
  const isExcludedUrl = (url: string) => isExternalUrl(url) || isDataUrl(url)

  return {
    name: 'vite:build-html',

    async transform(html, id) {
      if (id.endsWith('.html')) {
        const publicPath = `/${slash(path.relative(config.root, id))}`
        // pre-transform
        html = await applyHtmlTransforms(html, publicPath, id, preHooks)

        function formatError(e: any): Error {
          // normalize the error to rollup format
          if (e.loc) {
            e.frame = generateCodeFrame(html, e.loc.start.offset)
            e.loc = {
              file: id,
              line: e.loc.start.line,
              column: e.loc.start.column
            }
          }
          return e
        }

        // lazy load compiler-dom
        const { parse, transform } = await import('@vue/compiler-dom')
        // @vue/compiler-core doesn't like lowercase doctypes
        html = html.replace(/<!doctype\s/i, '<!DOCTYPE ')
        let ast
        try {
          ast = parse(html, { comments: true })
        } catch (e) {
          this.error(formatError(e))
        }

        const assetNodes: ElementNode[] = []
        try {
          transform(ast, {
            nodeTransforms: [
              (node) => {
                node.type === NodeTypes.ELEMENT &&
                  assetAttrsConfig[node.tag] &&
                  assetNodes.push(node)
              }
            ]
          })
        } catch (e) {
          this.error(formatError(e))
        }

        let js = ''
        let inlineModuleIndex = -1
        const s = new MagicString(html)

        for (const node of assetNodes) {
          let shouldRemove = false

          // For asset references in index.html, also generate an import
          // statement for each - this will be handled by the asset plugin
          const assetAttrs = assetAttrsConfig[node.tag]
          const assetRefs = node.props.filter(
            (p) => p.type === NodeTypes.ATTRIBUTE && assetAttrs.includes(p.name)
          ) as AttributeNode[]

          const isJsModule =
            node.tag === 'script' &&
            !!node.props.find(
              (p) =>
                p.type === NodeTypes.ATTRIBUTE &&
                p.name === 'type' &&
                p.value?.content === 'module'
            )

          if (isJsModule) {
            inlineModuleIndex++

            // <script type="module">...</script>
            if (!assetRefs.length && node.children.length) {
              js += `\nimport "${id}?html-proxy&index=${inlineModuleIndex}.js"`
              shouldRemove = true
            }
          }

          for (const assetRef of assetRefs) {
            const url = assetRef.value?.content
            if (!url || isExcludedUrl(url)) {
              continue
            }

            // check for excluded url after resolving
            if (!checkPublicFile(url, config.root)) {
              // <script type="module" src="..."/>
              if (isJsModule) {
                js += `\nimport ${JSON.stringify(url)}`
                shouldRemove = true
              }
              // CSS references
              else if (node.tag === 'link' && isCSSRequest(url)) {
                js += `\nimport ${JSON.stringify(url)}`
                shouldRemove = true
              }
            }

            // for each encountered asset url, rewrite original html so that it
            // references the post-build location.
            if (!shouldRemove) {
              const builtUrl = await urlToBuiltUrl(url, id, config, this)
              if (url !== builtUrl) {
                const { loc } = assetRef.value!
                s.overwrite(
                  loc.start.offset,
                  loc.end.offset,
                  JSON.stringify(builtUrl)
                )
              }
            }
          }

          // removed tags will be injected at the end
          if (shouldRemove) {
            s.remove(node.loc.start.offset, node.loc.end.offset)
          }
        }

        processedHtml.set(id, s.toString())

        // inject dynamic import polyfill
        if (config.build.polyfillDynamicImport) {
          js = `import "${polyfillId}";\n${js}`
        }

        return js
      }
    },

    async generateBundle(_, bundle) {
      const getPreloadLinksForChunk = (
        chunk: OutputChunk
      ): HtmlTagDescriptor[] => {
        const tags: HtmlTagDescriptor[] = []
        chunk.imports.forEach((file) => {
          const importee = bundle[file]
          if (importee && importee.type === 'chunk') {
            tags.push({
              tag: 'link',
              attrs: {
                rel: 'modulepreload',
                href: toPublicPath(file, config)
              }
            })
            tags.push(...getPreloadLinksForChunk(importee))
          }
        })
        return tags
      }

      const getCssTagsForChunk = (chunk: OutputChunk): HtmlTagDescriptor[] => {
        const tags: HtmlTagDescriptor[] = []
        const cssFileHandle = chunkToEmittedCssFileMap.get(chunk)
        if (cssFileHandle) {
          const file = this.getFileName(cssFileHandle)
          if (file) {
            tags.push({
              tag: 'link',
              attrs: {
                rel: 'stylesheet',
                href: toPublicPath(file, config)
              }
            })
          }
        }
        chunk.imports.forEach((file) => {
          const importee = bundle[file]
          if (importee && importee.type === 'chunk') {
            tags.push(...getCssTagsForChunk(importee))
          }
        })
        return tags
      }

      for (const [id, html] of processedHtml) {
        // resolve asset url references
        let result = html.replace(assetUrlRE, (_, fileId, postfix = '') => {
          return config.build.base + this.getFileName(fileId) + postfix
        })

        // find corresponding entry chunk
        const chunk = Object.values(bundle).find(
          (chunk) =>
            chunk.type === 'chunk' &&
            chunk.isEntry &&
            chunk.facadeModuleId === id
        ) as OutputChunk | undefined

        // inject chunk asset links
        if (chunk) {
          const assetTags = [
            // js entry chunk for this page
            {
              tag: 'script',
              attrs: {
                type: 'module',
                crossorigin: true,
                src: toPublicPath(chunk.fileName, config)
              }
            },
            // preload for imports
            ...getPreloadLinksForChunk(chunk),
            ...getCssTagsForChunk(chunk)
          ]

          result = injectToHead(result, assetTags)
        }

        // inject css link when cssCodeSplit is false
        if (!config.build.cssCodeSplit) {
          const cssChunk = Object.values(bundle).find(
            (chunk) => chunk.type === 'asset' && chunk.name === 'style.css'
          ) as OutputAsset | undefined
          if (cssChunk) {
            result = injectToHead(result, [
              {
                tag: 'link',
                attrs: {
                  rel: 'stylesheet',
                  href: toPublicPath(cssChunk.fileName, config)
                }
              }
            ])
          }
        }

        const shortEmitName = path.posix.relative(config.root, id)
        result = await applyHtmlTransforms(
          result,
          '/' + shortEmitName,
          id,
          postHooks,
          undefined,
          bundle,
          chunk
        )

        this.emitFile({
          type: 'asset',
          fileName: shortEmitName,
          source: result
        })
      }
    }
  }
}

export interface HtmlTagDescriptor {
  tag: string
  attrs?: Record<string, string | boolean>
  children?: string | HtmlTagDescriptor[]
  /**
   * default: 'head-prepend'
   */
  injectTo?: 'head' | 'body' | 'head-prepend' | 'body-prepend'
}

export type IndexHtmlTransformResult =
  | string
  | HtmlTagDescriptor[]
  | {
      html: string
      tags: HtmlTagDescriptor[]
    }

export interface IndexHtmlTransformContext {
  /**
   * public path when served
   */
  path: string
  /**
   * filename on disk
   */
  filename: string
  server?: ViteDevServer
  bundle?: OutputBundle
  chunk?: OutputChunk
}

export type IndexHtmlTransformHook = (
  html: string,
  ctx: IndexHtmlTransformContext
) => IndexHtmlTransformResult | void | Promise<IndexHtmlTransformResult | void>

export type IndexHtmlTransform =
  | IndexHtmlTransformHook
  | {
      enforce?: 'pre' | 'post'
      transform: IndexHtmlTransformHook
    }

export function resolveHtmlTransforms(plugins: readonly Plugin[]) {
  const preHooks: IndexHtmlTransformHook[] = []
  const postHooks: IndexHtmlTransformHook[] = []

  for (const plugin of plugins) {
    const hook = plugin.transformIndexHtml
    if (hook) {
      if (typeof hook === 'function') {
        postHooks.push(hook)
      } else if (hook.enforce === 'pre') {
        preHooks.push(hook.transform)
      } else {
        postHooks.push(hook.transform)
      }
    }
  }

  return [preHooks, postHooks]
}

export async function applyHtmlTransforms(
  html: string,
  path: string,
  filename: string,
  hooks: IndexHtmlTransformHook[],
  server?: ViteDevServer,
  bundle?: OutputBundle,
  chunk?: OutputChunk
): Promise<string> {
  const headTags: HtmlTagDescriptor[] = []
  const headPrependTags: HtmlTagDescriptor[] = []
  const bodyTags: HtmlTagDescriptor[] = []
  const bodyPrependTags: HtmlTagDescriptor[] = []

  const ctx: IndexHtmlTransformContext = {
    path,
    filename,
    server,
    bundle,
    chunk
  }

  for (const hook of hooks) {
    const res = await hook(html, ctx)
    if (!res) {
      continue
    }
    if (typeof res === 'string') {
      html = res
    } else {
      let tags
      if (Array.isArray(res)) {
        tags = res
      } else {
        html = res.html || html
        tags = res.tags
      }
      for (const tag of tags) {
        if (tag.injectTo === 'body') {
          bodyTags.push(tag)
        } else if (tag.injectTo === 'body-prepend') {
          bodyPrependTags.push(tag)
        } else if (tag.injectTo === 'head') {
          headTags.push(tag)
        } else {
          headPrependTags.push(tag)
        }
      }
    }
  }

  // inject tags
  if (headPrependTags.length) {
    html = injectToHead(html, headPrependTags, true)
  }
  if (headTags.length) {
    html = injectToHead(html, headTags)
  }
  if (bodyPrependTags.length) {
    html = injectToBody(html, bodyPrependTags, true)
  }
  if (bodyTags.length) {
    html = injectToBody(html, bodyTags)
  }

  return html
}

function toPublicPath(filename: string, config: ResolvedConfig) {
  return isExternalUrl(filename) ? filename : config.build.base + filename
}

const headInjectRE = /<\/head>/
const headPrependInjectRE = [/<head>/, /<!doctype html>/i]
function injectToHead(
  html: string,
  tags: HtmlTagDescriptor[],
  prepend = false
) {
  const tagsHtml = serializeTags(tags)
  if (prepend) {
    // inject after head or doctype
    for (const re of headPrependInjectRE) {
      if (re.test(html)) {
        return html.replace(re, `$&\n${tagsHtml}`)
      }
    }
  } else {
    // inject before head close
    if (headInjectRE.test(html)) {
      return html.replace(headInjectRE, `${tagsHtml}\n$&`)
    }
  }
  // if no <head> tag is present, just prepend
  return tagsHtml + `\n` + html
}

const bodyInjectRE = /<\/body>/
const bodyPrependInjectRE = /<body>/
function injectToBody(
  html: string,
  tags: HtmlTagDescriptor[],
  prepend = false
) {
  if (prepend) {
    // inject after body open
    const tagsHtml = `\n` + serializeTags(tags)
    if (bodyPrependInjectRE.test(html)) {
      return html.replace(bodyPrependInjectRE, `$&\n${tagsHtml}`)
    }
    // if no body, prepend
    return tagsHtml + `\n` + html
  } else {
    // inject before body close
    const tagsHtml = `\n` + serializeTags(tags)
    if (bodyInjectRE.test(html)) {
      return html.replace(bodyInjectRE, `${tagsHtml}\n$&`)
    }
    // if no body, append
    return html + `\n` + tagsHtml
  }
}

const unaryTags = new Set(['link', 'meta', 'base'])

function serializeTag({ tag, attrs, children }: HtmlTagDescriptor): string {
  if (unaryTags.has(tag)) {
    return `<${tag}${serializeAttrs(attrs)}>`
  } else {
    return `<${tag}${serializeAttrs(attrs)}>${serializeTags(children)}</${tag}>`
  }
}

function serializeTags(tags: HtmlTagDescriptor['children']): string {
  if (typeof tags === 'string') {
    return tags
  } else if (tags) {
    return tags.map(serializeTag).join(`\n  `)
  }
  return ''
}

function serializeAttrs(attrs: HtmlTagDescriptor['attrs']): string {
  let res = ''
  for (const key in attrs) {
    if (typeof attrs[key] === 'boolean') {
      res += attrs[key] ? ` ${key}` : ``
    } else {
      res += ` ${key}=${JSON.stringify(attrs[key])}`
    }
  }
  return res
}
