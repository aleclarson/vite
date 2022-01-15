import path from 'path'
import { createDebugger } from './utils'

const isDebug = !!process.env.DEBUG
const isVerbose = isDebug && false
const debug = createDebugger('vite:symlinks')

export interface SymlinkResolver {
  fsCalls: number
  cacheHits: number
  cacheSize: number
  realpathSync(path: string, seen?: Set<string>): string
  invalidate(path: string): void
}

export interface FileSystem {
  realpathSync: { native(path: string): string }
  readlinkSync(path: string): string
}

const packageJsonSuffix = '/package.json'

/**
 * Create a symlink resolver that uses a cache to reduce the
 * number of I/O calls. See #6030 for more information.
 */
export function createSymlinkResolver(
  root: string,
  fs: FileSystem = require('fs')
): SymlinkResolver {
  const cache: Record<string, string> = Object.create(null)

  // Recursively check the cache.
  const resolveWithCache = (unresolvedPath: string) => {
    let resolvedPath: string | undefined
    while (
      (resolvedPath = cache[unresolvedPath]) &&
      resolvedPath !== unresolvedPath
    ) {
      unresolvedPath = resolvedPath
    }
    return resolvedPath
  }

  const rootParent = path.dirname(root)
  const cacheRecursively = (resolvedPath: string) => {
    while (resolvedPath !== rootParent) {
      cache[resolvedPath] = resolvedPath
      resolvedPath = path.dirname(resolvedPath)
    }
  }

  return {
    // Increment "fsCalls" whenever fs.realpath or fs.readlink are called.
    fsCalls: 0,
    // Increment "cacheHits" when a call to our `realpathSync` method
    // is short-circuited by the cache.
    cacheHits: 0,
    get cacheSize() {
      return Object.keys(cache).length
    },
    // This method assumes `unresolvedPath` is normalized.
    realpathSync(unresolvedPath, seen) {
      if (isVerbose && !seen) {
        debug(`Called realpathSync on "${unresolvedPath}"`)
      }

      let resolvedPath = resolveWithCache(unresolvedPath)
      if (resolvedPath) {
        this.cacheHits++
        if (isVerbose) {
          debug(`Resolution of "${unresolvedPath}" was cached`)
        }
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

      // Optimize for "package.json" resolutions by assuming they're
      // never symlinks. This allows us to reuse cached "**/node_modules"
      // resolutions more often.
      const isPackageJson = unresolvedPath.endsWith(packageJsonSuffix)
      let unresolvedDir = isPackageJson
        ? path.dirname(unresolvedPath)
        : unresolvedPath

      // Use the nearest parent with a cached resolution.
      const cachedParent = cache[parentPath]
      if (!cachedParent || parentPath !== path.dirname(unresolvedDir)) {
        this.fsCalls++
        resolvedPath = fs.realpathSync.native(unresolvedPath)
        cache[unresolvedPath] = resolvedPath
        if (isDebug && unresolvedPath !== resolvedPath) {
          debug(`Resolved "${unresolvedPath}" to "${resolvedPath}"`)
        }
        // Since fs.realpath resolves all directories in a given path,
        // we can safely cache every directory in the resolved path.
        if (resolvedPath.startsWith(root + '/')) {
          cacheRecursively(resolvedPath)
        }
        return resolvedPath
      }

      // Append the unresolved part. Note this variable is only guaranteed
      // to be a directory when `isPackageJson` is true.
      let resolvedDir = cachedParent + unresolvedDir.slice(parentPath.length)
      parentPath = unresolvedDir

      // The `resolvedDir` is not fully resolved yet, as we still need to
      // check if the basename is a symlink too. But we still cache it
      // for faster recursive symlink resolutions in the future.
      if (resolvedDir !== unresolvedDir) {
        cache[unresolvedDir] = resolvedDir
        if (isDebug) {
          debug(`Resolved "${unresolvedDir}" to "${resolvedDir}"`)
        }

        // Check the cache again now that our parent directories are resolved.
        unresolvedDir = resolvedDir
        resolvedDir = resolveWithCache(unresolvedDir) || unresolvedDir
        if (resolvedDir !== unresolvedDir) {
          if (isVerbose) {
            debug(`Found "${unresolvedDir}" in cache`)
          }
          if (cachedParent) {
            this.cacheHits++
          }
          if (isPackageJson) {
            return resolvedDir + packageJsonSuffix
          }
          return resolvedDir
        }
      }

      // When the `unresolvedDir` is itself a symlink, we must follow it
      // *after* resolving parent directories, in case its target path is
      // pointing to a location outside a symlinked parent directory.
      try {
        this.fsCalls++
        const targetPath = fs.readlinkSync(resolvedDir)
        if (targetPath) {
          resolvedDir = path.resolve(path.dirname(resolvedDir), targetPath)

          // Avoid deadlocks from circular symlinks.
          if (seen?.has(resolvedDir)) {
            return unresolvedPath
          }
          seen ??= new Set()
          seen.add(resolvedDir)

          // The resolved path may be a file within a symlinked directory
          // and/or a symlink itself.
          resolvedDir = this.realpathSync(resolvedDir, seen)
        }
      } catch (e: any) {
        if (e.errno !== -22) {
          // Non-existent path or forbidden access
          return unresolvedPath
        }
      }

      // Append "/package.json" if necessary.
      resolvedPath = resolvedDir + (isPackageJson ? packageJsonSuffix : '')

      cache[unresolvedPath] = resolvedPath
      if (isDebug && resolvedPath !== unresolvedPath) {
        debug(`Resolved "${unresolvedPath}" to "${resolvedPath}"`)
      } else if (isVerbose && !seen) {
        debug(`Nothing to resolve for "${unresolvedPath}"`)
      }

      return resolvedPath
    },
    invalidate(unresolvedPath) {
      delete cache[unresolvedPath]
    }
  }
}
