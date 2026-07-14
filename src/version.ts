import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The running service's version, read from package.json rather than duplicated as a constant.
 *
 * A version number that has to be kept in sync by hand is a version number that will eventually
 * be wrong, and the one moment it matters is the moment someone is asking "which build is this?"
 * about a deployment that is misbehaving.
 *
 * package.json sits one directory above this file in both layouts that exist: `src/version.ts`
 * in development, and `dist/version.js` in the container, which the Dockerfile copies alongside
 * package.json.
 */
function readVersion(): string {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), '../package.json')
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const value = (parsed as { version: unknown }).version
      if (typeof value === 'string' && value.length > 0) return value
    }
  } catch {
    // Not fatal. An unknown version is worth strictly less than a service that refuses to boot.
  }
  return 'unknown'
}

export const version = readVersion()
