// Fails when chart content changed without increasing Chart.yaml's version over
// the selected base ref. This runs both on chart PRs and before publication.
import { readFileSync } from 'node:fs'
import { compareSemver, git, parseSemver } from './version-utils.mjs'

const chartPath = 'charts/cardano-wallet-backend'
const chartFile = `${chartPath}/Chart.yaml`

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

if (compareSemver(parseSemver(currentVersion), parseSemver(previousVersion)) <= 0) {
  console.error(
    `chart version not bumped: base ${previousVersion} vs current ${currentVersion}. ` +
      `Increase ${chartFile} whenever packaged chart content changes.`,
  )
  process.exit(1)
}

console.log(`chart version ok: ${previousVersion} -> ${currentVersion}`)
