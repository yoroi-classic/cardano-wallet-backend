// Fails if package.json version wasn't bumped above the base branch. Used by the
// version-check CI gate so every PR that advances the codebase carries a semver bump.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null }
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
  return a.pre > b.pre ? 1 : -1
}

const current = JSON.parse(readFileSync('package.json', 'utf8')).version
const currentParsed = parseSemver(current)
if (!currentParsed) {
  console.error(`current version "${current}" is not valid semver`)
  process.exit(1)
}

const baseRef = process.env.BASE_REF
let baseVersion = '0.0.0'
if (baseRef) {
  try {
    const baseJson = execSync(`git show ${baseRef}:package.json`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    baseVersion = JSON.parse(baseJson.toString()).version ?? '0.0.0'
  } catch {
    // No package.json on the base branch yet (first scaffold). Treat as 0.0.0.
    baseVersion = '0.0.0'
  }
}

const baseParsed = parseSemver(baseVersion) ?? { major: 0, minor: 0, patch: 0, pre: null }

if (compare(currentParsed, baseParsed) <= 0) {
  console.error(
    `version not bumped: base ${baseVersion} vs current ${current}. ` +
      `Bump package.json (and CHANGELOG.md) before merging.`,
  )
  process.exit(1)
}

console.log(`version ok: ${baseVersion} -> ${current}`)
