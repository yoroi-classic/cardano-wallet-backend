// Fails when chart content changed without increasing Chart.yaml's version over
// the selected base ref. This runs both on chart PRs and before publication.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const chartPath = 'charts/cardano-wallet-backend'
const chartFile = `${chartPath}/Chart.yaml`

function git(args, opts = {}) {
  return execFileSync('git', args, opts)
}

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  }
}

function comparePrerelease(a, b) {
  const left = a.split('.')
  const right = b.split('.')
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const xValue = BigInt(x)
      const yValue = BigInt(y)
      if (xValue !== yValue) return xValue < yValue ? -1 : 1
    } else if (xNumeric) {
      return -1
    } else if (yNumeric) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

function compare(a, b) {
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] - b[field]
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  return comparePrerelease(a.prerelease, b.prerelease)
}

function chartVersion(contents, source) {
  const line = contents
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith('version:'))
  if (line == null) throw new Error(`${source} has no chart version`)

  const match = /^version:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/.exec(line)
  const version = match?.[1] ?? match?.[2] ?? match?.[3]
  if (version == null || parseSemver(version) == null) {
    throw new Error(
      `${source} has invalid chart version ${JSON.stringify(line.slice('version:'.length).trim())}`,
    )
  }
  return version
}

const baseRef = process.env.BASE_REF
if (!baseRef) throw new Error('BASE_REF is required')

try {
  git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], { stdio: 'ignore' })
} catch {
  throw new Error(`base ref ${baseRef} not found; fetch it before running the check`)
}

try {
  git(['diff', '--quiet', baseRef, 'HEAD', '--', chartPath], { stdio: 'ignore' })
  console.log('chart version ok: chart content is unchanged')
  process.exit(0)
} catch {
  // A non-zero diff status means chart content changed and needs comparison.
}

try {
  git(['cat-file', '-e', `${baseRef}:${chartFile}`], { stdio: 'ignore' })
} catch {
  console.log('chart version ok: the base does not contain this chart yet')
  process.exit(0)
}

const currentVersion = chartVersion(readFileSync(chartFile, 'utf8'), chartFile)
const previousVersion = chartVersion(
  git(['show', `${baseRef}:${chartFile}`], { stdio: ['ignore', 'pipe', 'pipe'] }).toString(),
  `${baseRef}:${chartFile}`,
)

if (compare(parseSemver(currentVersion), parseSemver(previousVersion)) <= 0) {
  console.error(
    `chart version not bumped: base ${previousVersion} vs current ${currentVersion}. ` +
      `Increase ${chartFile} whenever packaged chart content changes.`,
  )
  process.exit(1)
}

console.log(`chart version ok: ${previousVersion} -> ${currentVersion}`)
