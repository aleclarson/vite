import fs from 'fs'
import path from 'path'
import { createDebugger } from './utils'

const debug = createDebugger('vite:symlinks')

export interface SymlinkResolver {
  realpathSync(path: string): string
  invalidate(path: string): void
}

/**
 * Create a symlink resolver that uses a cache to reduce the
 * number of I/O calls. See #6030 for more information.
 */
export function createSymlinkResolver(root: string): SymlinkResolver {
  const cache: Record<string, string> = {}
  return {
    // This method assumes `targetPath` is normalized.
    realpathSync(unresolvedPath) {
      let resolvedPath = cache[unresolvedPath]
      if (resolvedPath) {
        return resolvedPath
      }

      let parentPath = path.dirname(unresolvedPath)

      // Check all parent directories within the project root.
      // If our unresolved path is outside the project root, we only
      // check the immediate parent directory (for optimal performance).
      const isInRoot = unresolvedPath.startsWith(root + '/')
      if (isInRoot)
        while (parentPath !== root && !cache[parentPath]) {
          parentPath = path.dirname(parentPath)
        }

      resolvedPath = cache[parentPath]
      if (!resolvedPath) {
        if (isInRoot) {
          parentPath = path.dirname(unresolvedPath)
        }
        debug(`using fs.realpath on "${parentPath}"`)
        resolvedPath = fs.realpathSync.native(parentPath)
        cache[parentPath] = resolvedPath
      }
      resolvedPath += unresolvedPath.slice(parentPath.length)

      // When the `unresolvedPath` is itself a symlink, we must follow it
      // *after* resolving parent directories, in case its target path is
      // pointing to a location outside a symlinked parent directory.
      let targetPath: string | undefined
      try {
        const seen = new Set([resolvedPath])
        while ((targetPath = fs.readlinkSync(resolvedPath))) {
          resolvedPath = path.resolve(path.dirname(resolvedPath), targetPath)

          // Avoid deadlock from circular symlink
          if (seen.has(resolvedPath)) {
            return unresolvedPath
          }
          seen.add(resolvedPath)
        }
      } catch (e: any) {
        if (e.errno !== -22) {
          // Non-existent path or forbidden access
          return unresolvedPath
        }
        if (targetPath) {
          return this.realpathSync(resolvedPath)
        }
      }
      return resolvedPath
    },
    invalidate(unresolvedPath) {
      delete cache[unresolvedPath]
    }
  }
}
