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
assert.deepEqual(Object.keys(chart.jobs), ['cardano-wallet-backend', 'publish'])
assert.equal(image.env.SOURCE_SHA, '${{ github.event.workflow_run.head_sha || github.sha }}')
assert.equal(
  image.env.SOURCE_BRANCH,
  '${{ github.event.workflow_run.head_branch || github.ref_name }}',
)
const branches = ['development', 'preview', 'preprod', 'main']
assert.deepEqual(image.on.workflow_run.branches, branches, 'restrict publication branches')
assert.deepEqual(image.on.workflow_run.workflows, ['ci'])
assert.deepEqual(image.on.workflow_run.types, ['completed'])
assert.equal(
  image.concurrency.group,
  'publish-image-${{ github.event.workflow_run.head_sha || github.sha }}',
)
assert.equal(image.concurrency['cancel-in-progress'], false)
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

function assertExistingImageProbeContract(source) {
  assert.deepEqual(
    source.jobs.prepare.outputs,
    {
      ref: '${{ steps.image.outputs.ref }}',
      publish: '${{ steps.image.outputs.publish }}',
      digest: '${{ steps.image.outputs.digest }}',
    },
    'publication outputs must preserve the image probe decision',
  )
  const probe = named(source.jobs.prepare.steps, 'Check whether this revision is published')
  mandatory(probe)
  assert.equal(probe.id, 'image', 'the existing-image decision must feed publication')
  assert.equal(
    probe.run,
    [
      'set -euo pipefail',
      'image="ghcr.io/${GITHUB_REPOSITORY,,}:sha-$SOURCE_SHA"',
      'echo "ref=$image" >> "$GITHUB_OUTPUT"',
      'if docker buildx imagetools inspect "$image" > "$RUNNER_TEMP/image-probe" 2>&1; then',
      '  digest=$(awk \'$1 == "Digest:" { print $2; exit }\' "$RUNNER_TEMP/image-probe")',
      '  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]',
      '  echo "digest=$digest" >> "$GITHUB_OUTPUT"',
      '  echo \'publish=false\' >> "$GITHUB_OUTPUT"',
      'elif grep -Eq "^ERROR: ${image}: (not found|manifest unknown(: manifest unknown)?)$" "$RUNNER_TEMP/image-probe"; then',
      '  echo \'publish=true\' >> "$GITHUB_OUTPUT"',
      'else',
      '  cat "$RUNNER_TEMP/image-probe" >&2',
      '  exit 1',
      'fi',
      '',
    ].join('\n'),
    'existing-image lookup must skip published revisions and fail on registry errors',
  )
}

function assertArchitectureTagContract(source) {
  const pushStep = named(source.jobs.build.steps, 'Push the tested architecture image')
  mandatory(pushStep)
  assert.equal(
    pushStep.env.IMAGE_REF,
    '${{ needs.prepare.outputs.ref }}-${{ matrix.arch }}',
    'each architecture must be staged under a distinct tag',
  )
  assert.equal(
    pushStep.run,
    'docker tag cardano-wallet-backend:ci "$IMAGE_REF"\ndocker push "$IMAGE_REF"\n',
    'push only the architecture-specific candidate tag',
  )

  const manifest = named(source.jobs.publish.steps, 'Publish multi-architecture manifest')
  assert.equal(manifest.if, "needs.prepare.outputs.publish == 'true'")
  assert.ok(!manifest['continue-on-error'], 'manifest publication errors must fail closed')
  assert.equal(
    manifest.env?.IMAGE_REF ?? source.jobs.publish.env.IMAGE_REF,
    '${{ needs.prepare.outputs.ref }}',
    'publish the final manifest to the probed commit reference',
  )
  assert.equal(
    manifest.run,
    [
      'set -euo pipefail',
      'docker buildx imagetools create --tag "$IMAGE_REF" "$IMAGE_REF-amd64" "$IMAGE_REF-arm64"',
      '',
    ].join('\n'),
    'manifest must include both tested architecture tags',
  )
}

function assertBuildSourceContract(source) {
  const jobs = source.jobs
  const steps = jobs.build.steps
  const build = action(steps, 'docker/build-push-action')
  assert.deepEqual(
    build.with,
    {
      context: '.',
      platforms: 'linux/${{ matrix.arch }}',
      load: true,
      pull: true,
      tags: 'cardano-wallet-backend:ci',
      labels:
        'org.opencontainers.image.source=https://github.com/${{ github.repository }}\n' +
        'org.opencontainers.image.revision=${{ env.SOURCE_SHA }}\n',
      'no-cache-filters': 'runtime',
      'cache-from': 'type=gha,scope=image-${{ matrix.arch }}',
      'cache-to': 'type=gha,mode=max,scope=image-${{ matrix.arch }}',
    },
    'build the checked-out source with the pinned candidate image settings',
  )
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const key of ['SOURCE_SHA', 'SOURCE_BRANCH']) {
      assert.equal(job.env?.[key], undefined, `${jobName} must not override workflow ${key}`)
    }
    for (const step of job.steps ?? []) {
      for (const key of ['SOURCE_SHA', 'SOURCE_BRANCH']) {
        assert.equal(
          step.env?.[key],
          undefined,
          `${jobName}/${step.name ?? step.uses} must not override workflow ${key}`,
        )
      }
    }
  }
}

assertExistingImageProbeContract(image)
assertArchitectureTagContract(image)
assertBuildSourceContract(image)

const cloneWorkflow = (workflow) => JSON.parse(JSON.stringify(workflow))
const changedProbe = cloneWorkflow(image)
const changedProbeStep = named(
  changedProbe.jobs.prepare.steps,
  'Check whether this revision is published',
)
changedProbeStep.run = changedProbeStep.run.replace("echo 'publish=false'", "echo 'publish=true'")
assert.throws(
  () => assertExistingImageProbeContract(changedProbe),
  /existing-image lookup must skip published revisions/,
  'contract must reject rebuilding over an existing commit tag',
)

const changedProbeError = cloneWorkflow(image)
const changedProbeErrorStep = named(
  changedProbeError.jobs.prepare.steps,
  'Check whether this revision is published',
)
changedProbeErrorStep.run = changedProbeErrorStep.run.replace(
  '  exit 1',
  '  echo \'publish=true\' >> "$GITHUB_OUTPUT"',
)
assert.throws(
  () => assertExistingImageProbeContract(changedProbeError),
  /existing-image lookup must skip published revisions/,
  'contract must reject publishing after a registry lookup error',
)

const forcedPreparePublish = cloneWorkflow(image)
forcedPreparePublish.jobs.prepare.outputs.publish = 'true'
assert.throws(
  () => assertExistingImageProbeContract(forcedPreparePublish),
  /publication outputs must preserve the image probe decision/,
  'contract must reject bypassing the existing-image decision',
)

const wrongPrepareRef = cloneWorkflow(image)
wrongPrepareRef.jobs.prepare.outputs.ref = '${{ steps.image.outputs.ref }}-amd64'
assert.throws(
  () => assertExistingImageProbeContract(wrongPrepareRef),
  /publication outputs must preserve the image probe decision/,
  'contract must reject redirecting publication away from the probed image',
)

const unscopedArchitectureTag = cloneWorkflow(image)
named(
  unscopedArchitectureTag.jobs.build.steps,
  'Push the tested architecture image',
).env.IMAGE_REF = '${{ needs.prepare.outputs.ref }}'
assert.throws(
  () => assertArchitectureTagContract(unscopedArchitectureTag),
  /each architecture must be staged under a distinct tag/,
  'contract must reject direct publication of one architecture under the final tag',
)

const incompleteManifest = cloneWorkflow(image)
const incompleteManifestStep = named(
  incompleteManifest.jobs.publish.steps,
  'Publish multi-architecture manifest',
)
incompleteManifestStep.run = incompleteManifestStep.run.replace(' "$IMAGE_REF-arm64"', '')
assert.throws(
  () => assertArchitectureTagContract(incompleteManifest),
  /manifest must include both tested architecture tags/,
  'contract must reject a manifest missing an architecture',
)

const wrongManifestDestination = cloneWorkflow(image)
wrongManifestDestination.jobs.publish.env.IMAGE_REF = '${{ needs.prepare.outputs.ref }}-amd64'
assert.throws(
  () => assertArchitectureTagContract(wrongManifestDestination),
  /publish the final manifest to the probed commit reference/,
  'contract must reject publishing the manifest to an architecture staging tag',
)

const stepManifestDestination = cloneWorkflow(image)
named(stepManifestDestination.jobs.publish.steps, 'Publish multi-architecture manifest').env = {
  IMAGE_REF: '${{ needs.prepare.outputs.ref }}-amd64',
}
assert.throws(
  () => assertArchitectureTagContract(stepManifestDestination),
  /publish the final manifest to the probed commit reference/,
  'contract must reject overriding the manifest destination at the step level',
)

const missingBuildContext = cloneWorkflow(image)
delete action(missingBuildContext.jobs.build.steps, 'docker/build-push-action').with.context
assert.throws(
  () => assertBuildSourceContract(missingBuildContext),
  /build the checked-out source with the pinned candidate image settings/,
  'contract must reject a build that falls back to the action default Git context',
)

const overriddenBuildSource = cloneWorkflow(image)
overriddenBuildSource.jobs.build.env = { SOURCE_SHA: '${{ github.sha }}' }
assert.throws(
  () => assertBuildSourceContract(overriddenBuildSource),
  /build must not override workflow SOURCE_SHA/,
  'contract must reject a job-level override of the verified source revision',
)

const overriddenStepSource = cloneWorkflow(image)
named(overriddenStepSource.jobs.build.steps, 'Build candidate image').env = {
  SOURCE_BRANCH: '${{ github.ref_name }}',
}
assert.throws(
  () => assertBuildSourceContract(overriddenStepSource),
  /Build candidate image must not override workflow SOURCE_BRANCH/,
  'contract must reject a step-level override of the verified source branch',
)

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
  build.with.load === true && build.with.push === undefined,
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
assert.equal(proof.env.GH_TOKEN, '${{ github.token }}')
assert.equal(
  proof.run,
  `set -euo pipefail
runs=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml \\
  --branch "$SOURCE_BRANCH" --commit "$SOURCE_SHA" --event push \\
  --status success --json databaseId --jq length)
test "$runs" -gt 0
`,
  'CI proof must query successful push runs for the exact source revision',
)
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
assert.equal(
  fold(chart.jobs.publish.if),
  "github.event_name == 'push' && (github.ref == 'refs/heads/development' || github.ref == 'refs/heads/main')",
  'charts publish only from development/main pushes',
)
assert.equal(
  chart.jobs.publish.needs,
  'cardano-wallet-backend',
  'chart publication follows validation',
)
const chartPush = named(chart.jobs.publish.steps, 'Publish OCI chart')
assert.equal(
  chartPush.if,
  "steps.chart.outputs.publish == 'true'",
  'only publish newly approved chart contents',
)
assert.ok(!chartPush['continue-on-error'], 'chart push errors must fail')
assert.equal(chartPush.env.PACKAGE_PATH, '${{ steps.chart.outputs.package_path }}')
assert.equal(chartPush.run, 'helm push "$PACKAGE_PATH" oci://ghcr.io/yoroi-classic/charts\n')
const chartDecision = named(chart.jobs.publish.steps, 'Decide whether to publish')
mandatory(chartDecision)
assert.ok(
  chartDecision.run.endsWith(`if [ "$published" = true ]; then
  mkdir -p "$RUNNER_TEMP/published-chart" "$RUNNER_TEMP/candidate-chart"
  helm pull "$chart_ref" --version "$version" --destination "$RUNNER_TEMP/published-chart"
  tar -xzf "$RUNNER_TEMP/published-chart/$archive" -C "$RUNNER_TEMP/published-chart"
  tar -xzf "$package_path" -C "$RUNNER_TEMP/candidate-chart"
  if ! diff -qr "$RUNNER_TEMP/published-chart/cardano-wallet-backend" \\
      "$RUNNER_TEMP/candidate-chart/cardano-wallet-backend"; then
    echo "::error::Chart version $version already contains different chart content; bump Chart.yaml"
    exit 1
  fi
  echo "publish=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

echo "publish=true" >> "$GITHUB_OUTPUT"
`),
  'chart publication must compare the published archive with the candidate and fail on a content mismatch',
)

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
  executable(
    directory,
    'docker',
    `test "$1 $2 $3" = 'buildx imagetools inspect'
    test "$4" = "ghcr.io/\${GITHUB_REPOSITORY,,}:sha-\${SOURCE_SHA}"
    printf '%s\\n' "$TEST_PROBE_OUTPUT" >&2
    exit "\${TEST_PROBE_STATUS:-1}"
  `,
  )
  const probe = named(image.jobs.prepare.steps, 'Check whether this revision is published')
  writeFileSync(join(directory, 'output'), '')
  const missingImage = shell(probe, directory, {
    TEST_PROBE_OUTPUT: `ERROR: ghcr.io/test-only/backend:sha-${'1'.repeat(40)}: manifest unknown`,
  })
  assert.equal(missingImage.status, 0, missingImage.stderr)
  assert.match(
    readFileSync(join(directory, 'output'), 'utf8'),
    /^publish=true$/m,
    'publish only when the target commit manifest is missing',
  )
  writeFileSync(join(directory, 'output'), '')
  const missingManifest = shell(probe, directory, {
    TEST_PROBE_OUTPUT: `ERROR: ghcr.io/test-only/backend:sha-${'1'.repeat(40)}: not found`,
  })
  assert.equal(missingManifest.status, 0, missingManifest.stderr)
  assert.match(
    readFileSync(join(directory, 'output'), 'utf8'),
    /^publish=true$/m,
    'accept the registry not-found response for the target commit manifest',
  )
  writeFileSync(join(directory, 'output'), '')
  const unrelatedProbeError = shell(probe, directory, {
    TEST_PROBE_OUTPUT: 'ERROR: registry proxy lookup failed: not found',
  })
  assert.notEqual(unrelatedProbeError.status, 0, 'fail closed on unrelated registry errors')
  assert.doesNotMatch(
    readFileSync(join(directory, 'output'), 'utf8'),
    /publish=true/,
    'an unrelated registry error must not authorize publication',
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
