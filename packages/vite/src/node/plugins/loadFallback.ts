import { promises as fs } from 'fs'
import { Plugin } from '..'
import { cleanUrl } from '../utils'

/**
 * A plugin to provide build load fallback for arbitrary request with queries.
 */
export function loadFallbackPlugin(): Plugin {
  return {
    name: 'vite:load-fallback',
    async load(id) {
      const filename = cleanUrl(id)
      const code = await fs.readFile(filename, 'utf-8')
      return { code, meta: { filename } }
    }
  }
}
