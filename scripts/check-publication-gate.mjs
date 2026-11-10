// Protect the artifact publication boundary using workflow structure and the real
// decision commands against disposable, offline registry/CI fixtures.
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'

// CI runs the trusted base copy from RUNNER_TEMP, with dependencies from this checkout.
const require = createRequire(resolve('package.json'))
const { parse } = require('yaml')
const image = parse(readFileSync('.github/workflows/publish-image.yml', 'utf8'))
const chart = parse(readFileSync('.github/workflows/helm-chart.yml', 'utf8'))
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
assert.deepEqual(Object.keys(image.jobs), ['prepare', 'build', 'publish'])
assert.equal(image.env.SOURCE_SHA, '${{ github.event.workflow_run.head_sha || github.sha }}')
assert.equal(
  image.env.SOURCE_BRANCH,
  '${{ github.event.workflow_run.head_branch || github.ref_name }}',
)
const branches = ['development', 'preview', 'preprod', 'main']
assert.deepEqual(image.on.workflow_run.branches, branches, 'restrict publication branches')
assert.deepEqual(image.on.workflow_run.workflows, ['ci'])
assert.deepEqual(image.on.workflow_run.types, ['completed'])
const fold = (value) => value.trim().replace(/\s+/g, ' ')
const action = (steps, prefix) => {
  const found = steps.filter((step) => step.uses?.startsWith(prefix + '@'))
  assert.equal(found.length, 1, `require exactly one ${prefix} step`)
  return found[0]
}
const named = (steps, name) => {
  const found = steps.filter((step) => step.name === name)
  assert.equal(found.length, 1, `missing publication step: ${name}`)
  return found[0]
}
const mandatory = (step) => {
  assert.equal(step.if, undefined, `${step.name ?? step.uses} must not be conditional`)
  assert.ok(!step['continue-on-error'], `${step.name ?? step.uses} must fail closed`)
}

assert.equal(
  fold(image.jobs.prepare.if),
  `(github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_repository.full_name == github.repository) || (github.event_name == 'workflow_dispatch' && contains(fromJSON('["development","preview","preprod","main"]'), github.ref_name))`,
  'publication must require a successful same-repository push or an allowed manual dispatch',
)
assert.equal(image.jobs.build.needs, 'prepare')
assert.equal(image.jobs.build.if, "needs.prepare.outputs.publish == 'true'")
assert.deepEqual(image.jobs.build.strategy.matrix.arch, ['amd64', 'arm64'])
assert.ok(!image.jobs.build['continue-on-error'], 'architecture failures must block the manifest')
assert.deepEqual(image.jobs.publish.needs, ['prepare', 'build'])
assert.equal(
  fold(image.jobs.publish.if),
  "always() && needs.prepare.result == 'success' && (needs.prepare.outputs.publish == 'false' || needs.build.result == 'success')",
  'a new manifest must require successful architecture builds',
)
const steps = image.jobs.build.steps
const build = action(steps, 'docker/build-push-action')
const scan = action(steps, 'aquasecurity/trivy-action')
const ciScan = action(ci.jobs['build-test'].steps, 'aquasecurity/trivy-action')
const smoke = named(steps, 'Smoke-test the exact candidate image')
const push = named(steps, 'Push the tested architecture image')
for (const step of [build, scan, smoke, push]) mandatory(step)
assert.ok(
  build.with.load === true && build.with.push !== true,
  'load the candidate without pushing',
)
assert.equal(build.with.pull, true, 'refresh mutable base images')
assert.equal(build.with['no-cache-filters'], 'runtime', 'refresh runtime security packages')
assert.equal(build.with.tags, 'cardano-wallet-backend:ci')
assert.equal(build.with.platforms, 'linux/${{ matrix.arch }}')
assert.equal(scan.uses, ciScan.uses, 'use the CI vulnerability scanner revision')
const scanSettings = {
  'image-ref': 'cardano-wallet-backend:ci',
  scanners: 'vuln',
  severity: 'HIGH,CRITICAL',
  'ignore-unfixed': true,
  'exit-code': '1',
  format: 'table',
}
assert.deepEqual(
  scan.with,
  scanSettings,
  'scan the exact candidate with mandatory severity/exit settings',
)
assert.deepEqual(scan.with, ciScan.with, 'match the shipped CI scan settings')
assert.equal(smoke.run, 'bash scripts/smoke-docker-image.sh')
assert.equal(
  push.run,
  'docker tag cardano-wallet-backend:ci "$IMAGE_REF"\ndocker push "$IMAGE_REF"\n',
)
assert.ok(
  steps.indexOf(build) < steps.indexOf(scan) &&
    steps.indexOf(scan) < steps.indexOf(smoke) &&
    steps.indexOf(smoke) < steps.indexOf(push),
  'scan and smoke-test the exact candidate before pushing it',
)
const checkout = action(steps, 'actions/checkout')
assert.equal(checkout.with.ref, '${{ env.SOURCE_SHA }}', 'build the CI-verified source revision')
const proof = named(image.jobs.prepare.steps, 'Require successful CI for this revision')
mandatory(proof)
const ciCheck = named(ci.jobs['build-test'].steps, 'Check publication gate contract')
mandatory(ciCheck)
assert.equal(ciCheck.env.TRUSTED_BASE_SHA, '${{ github.event.pull_request.base.sha }}')
assert.match(String(ciCheck.env.BOOTSTRAP_GATE_SHA), /^[0-9a-f]{40}$/)
assert.equal(
  ciCheck.run,
  `if [ "$GITHUB_EVENT_NAME" = pull_request ]; then
  if git cat-file -e "$TRUSTED_BASE_SHA:scripts/check-publication-gate.mjs" 2>/dev/null; then
    git show "$TRUSTED_BASE_SHA:scripts/check-publication-gate.mjs" \\
      > "$RUNNER_TEMP/check-publication-gate.mjs"
  else
    git fetch --no-tags origin "$BOOTSTRAP_GATE_SHA"
    git show "$BOOTSTRAP_GATE_SHA:scripts/check-publication-gate.mjs" \\
      > "$RUNNER_TEMP/check-publication-gate.mjs"
  fi
  node "$RUNNER_TEMP/check-publication-gate.mjs"
else
  npm run check:publication-gate
fi
`,
  'CI must use the trusted base or immutable bootstrap checker, without a PR-copy fallback',
)
const chartDecision = named(chart.jobs.publish.steps, 'Decide whether to publish')
mandatory(chartDecision)

function shell(step, directory, variables = {}) {
  const result = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run],
    {
      cwd: directory,
      env: {
        PATH: join(directory, 'bin') + ':/usr/bin:/bin',
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: join(directory, 'output'),
        GITHUB_REPOSITORY: 'test-only/backend',
        SOURCE_BRANCH: 'development',
        SOURCE_SHA: '1'.repeat(40),
        GH_TOKEN: 'test-only',
        BEFORE: '2'.repeat(40),
        ...variables,
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  )
  assert.ifError(result.error)
  return result
}
function executable(directory, name, body) {
  writeFileSync(join(directory, 'bin', name), '#!/bin/bash\nset -euo pipefail\n' + body, {
    mode: 0o700,
  })
}
const directory = mkdtempSync(join(tmpdir(), 'publication-gate-test-'))
try {
  mkdirSync(join(directory, 'bin'))
  executable(
    directory,
    'gh',
    `
    test "$1 $2" = 'run list'
    shift 2
    declare -A seen
    while [ "$#" -gt 0 ]; do
      key="$1"; value="$2"; shift 2
      seen["$key"]=1
      case "$key" in
        --repo) test "$value" = "$GITHUB_REPOSITORY" ;;
        --workflow) test "$value" = ci.yml ;;
        --branch) test "$value" = "$SOURCE_BRANCH" ;;
        --commit) test "$value" = "$SOURCE_SHA" ;;
        --event) test "$value" = push ;;
        --status) test "$value" = success ;;
        --json) test "$value" = databaseId ;;
        --jq) test "$value" = length ;;
        *) exit 99 ;;
      esac
    done
    test "\${#seen[@]}" -eq 8
    printf '%s\\n' "$TEST_CI_RUNS"
  `,
  )
  assert.equal(
    shell(proof, directory, { TEST_CI_RUNS: '1' }).status,
    0,
    'accept successful push CI',
  )
  assert.notEqual(
    shell(proof, directory, { TEST_CI_RUNS: '0' }).status,
    0,
    'refuse revisions without successful push CI',
  )

  executable(directory, 'node', 'exit 0\n') // Chart-version validation is tested separately.
  executable(
    directory,
    'helm',
    `case "$1" in
    package) printf 'Successfully packaged chart and saved it to: %s/cardano-wallet-backend-0.1.3.tgz\\n' "$RUNNER_TEMP" ;;
    show) exit 0 ;;
    pull) cp "$TEST_PUBLISHED_ARCHIVE" "$RUNNER_TEMP/published-chart/cardano-wallet-backend-0.1.3.tgz" ;;
    *) exit 99 ;;
  esac\n`,
  )
  const fixture = join(directory, 'fixture')
  mkdirSync(join(fixture, 'cardano-wallet-backend'), { recursive: true })
  const values = join(fixture, 'cardano-wallet-backend', 'values.yaml')
  writeFileSync(values, 'image: tested-revision\n')
  execFileSync('tar', [
    '-czf',
    join(directory, 'cardano-wallet-backend-0.1.3.tgz'),
    '-C',
    fixture,
    'cardano-wallet-backend',
  ])
  const published = join(directory, 'published.tgz')
  execFileSync('tar', ['-czf', published, '-C', fixture, 'cardano-wallet-backend'])
  const same = shell(chartDecision, directory, { TEST_PUBLISHED_ARCHIVE: published })
  assert.equal(same.status, 0, same.stderr)
  assert.match(
    readFileSync(join(directory, 'output'), 'utf8'),
    /^publish=false$/m,
    'reuse an identical published chart',
  )
  writeFileSync(join(directory, 'output'), '')
  writeFileSync(values, 'image: different-revision\n')
  execFileSync('tar', ['-czf', published, '-C', fixture, 'cardano-wallet-backend'])
  const changed = shell(chartDecision, directory, { TEST_PUBLISHED_ARCHIVE: published })
  assert.notEqual(changed.status, 0, 'refuse changed contents under an existing chart version')
  assert.match(
    changed.stdout,
    /different chart content/,
    'reject chart content mismatch, not a fixture error',
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
console.log(
  'Publication gate: verified CI, scanned candidates, build dependencies and immutable chart contents',
)
