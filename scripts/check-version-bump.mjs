// Fails if package.json version wasn't bumped above the base branch. Used by the
// version-check CI gate so every PR that advances the codebase carries a semver bump.
import { readFileSync } from 'node:fs'
import { compareSemver, git, parseSemver } from './version-utils.mjs'

function baseHasPackageJson(baseRef) {
  // A missing or unfetched ref is an operational error, not the first-scaffold case, so
  // fail loudly rather than silently comparing against 0.0.0 and passing anything.
  try {
    git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], { stdio: 'ignore' })
  } catch {
    throw new Error(`base ref ${baseRef} not found; fetch it before running the check`)
  }
  // Ref exists. Only an absent package.json on it counts as the first-scaffold case.
  try {
    git(['cat-file', '-e', `${baseRef}:package.json`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const current = JSON.parse(readFileSync('package.json', 'utf8')).version
const currentParsed = parseSemver(current)
if (!currentParsed) {
  console.error(`current version "${current}" is not valid semver`)
  process.exit(1)
}

const baseRef = process.env.BASE_REF
let baseVersion = '0.0.0'
if (baseRef && baseHasPackageJson(baseRef)) {
  // The base has a package.json, so any failure reading or parsing it is a real problem.
  // Let it throw and fail the gate rather than silently falling back and passing.
  const baseJson = git(['show', `${baseRef}:package.json`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  baseVersion = JSON.parse(baseJson.toString()).version ?? '0.0.0'
}
// If the base has no package.json yet (first time it's added), baseVersion stays 0.0.0.

const baseParsed = parseSemver(baseVersion)
if (!baseParsed) {
  console.error(`base version "${baseVersion}" is not valid semver`)
  process.exit(1)
}

if (compareSemver(currentParsed, baseParsed) <= 0) {
  console.error(
    `version not bumped: base ${baseVersion} vs current ${current}. ` +
      `Bump package.json (and CHANGELOG.md) before merging.`,
  )
  process.exit(1)
}

console.log(`version ok: ${baseVersion} -> ${current}`)
