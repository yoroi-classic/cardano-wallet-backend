// Fails if package.json version wasn't bumped above the base branch. Used by the
// version-check CI gate so every PR that advances the codebase carries a semver bump.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Run git with an argument array (never a shell string) so a value like BASE_REF, which
// can contain attacker-influenced characters on a fork PR, is passed as a literal arg
// and can't inject shell commands.
function git(args, opts = {}) {
  return execFileSync('git', args, opts)
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null }
}

// Compare two prerelease strings per the semver spec: dot-separated identifiers,
// numeric ones compared numerically, numeric ranking below alphanumeric, and a longer
// identifier set outranking a shorter prefix. So beta.2 < beta.10 and alpha < alpha.1.
function comparePre(a, b) {
  const as = a.split('.')
  const bs = b.split('.')
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      // BigInt so very large numeric identifiers compare without precision loss.
      const xb = BigInt(x)
      const yb = BigInt(y)
      if (xb !== yb) return xb < yb ? -1 : 1
    } else if (xn) {
      return -1
    } else if (yn) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

// Returns >0 if a is greater than b, <0 if less, 0 if equal. A release outranks a
// prerelease of the same core version (1.0.0 > 1.0.0-rc.1).
function compare(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] - b[k]
  }
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return comparePre(a.pre, b.pre)
}

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

if (compare(currentParsed, baseParsed) <= 0) {
  console.error(
    `version not bumped: base ${baseVersion} vs current ${current}. ` +
      `Bump package.json (and CHANGELOG.md) before merging.`,
  )
  process.exit(1)
}

console.log(`version ok: ${baseVersion} -> ${current}`)
