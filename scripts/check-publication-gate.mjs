// Keep image and chart publication tied to CI-validated, fully scanned artifacts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
const imageWorkflow = readFileSync('.github/workflows/publish-image.yml', 'utf8')
const chartWorkflow = readFileSync('.github/workflows/helm-chart.yml', 'utf8')

function requireText(source, text, message) {
  assert.ok(source.includes(text), message)
}

function assertInOrder(source, markers, message) {
  const positions = markers.map((marker) => source.indexOf(marker))
  assert.ok(
    positions.every((position) => position !== -1),
    `${message}: missing step`,
  )
  assert.deepEqual(
    positions,
    [...positions].sort((left, right) => left - right),
    message,
  )
}

function assertImagePublicationContract(source) {
  for (const [text, message] of [
    ['workflows: [ci]', 'image publication must follow CI'],
    ["github.event.workflow_run.conclusion == 'success'", 'CI must succeed'],
    ["github.event.workflow_run.event == 'push'", 'PR CI must not publish'],
    [
      'github.event.workflow_run.head_repository.full_name == github.repository',
      'fork code must not publish',
    ],
    [
      '--branch "$SOURCE_BRANCH" --commit "$SOURCE_SHA" --event push',
      'CI lookup must use the source commit',
    ],
    ['--status success --json databaseId --jq length', 'CI lookup must require a successful run'],
    ['test "$runs" -gt 0', 'publication must stop without successful CI'],
    ['matrix:\n        arch: [amd64, arm64]', 'both supported architectures must be built'],
    ['pull: true', 'candidate builds must fetch the current base image'],
    ['no-cache-filters: runtime', 'the runtime package upgrade must not use cached layers'],
    ['name: Scan the exact candidate image', 'each candidate image must be scanned'],
    ["exit-code: '1'", 'HIGH/CRITICAL scan findings must fail the build'],
    ['severity: HIGH,CRITICAL', 'the scan must include HIGH and CRITICAL findings'],
    ['ignore-unfixed: true', 'the scan must ignore only advisories without a fix'],
    ['needs: [prepare, build]', 'publication must depend on the image build'],
    [
      "needs.prepare.outputs.publish == 'false' || needs.build.result == 'success'",
      'all new image tags must have successful builds',
    ],
  ]) {
    requireText(source, text, message)
  }

  assertInOrder(
    source,
    [
      '      - name: Build candidate image',
      '      - name: Scan the exact candidate image',
      '      - name: Smoke-test the exact candidate image',
      '      - name: Push the tested architecture image',
    ],
    'scan and smoke tests must finish before an architecture image is pushed',
  )
}

function assertChartPublicationContract(source) {
  for (const [text, message] of [
    ["github.ref == 'refs/heads/development'", 'development chart publication must remain enabled'],
    ["github.ref == 'refs/heads/main'", 'main chart publication must remain enabled'],
    ['needs: cardano-wallet-backend', 'chart publication must follow chart validation'],
    ['helm pull "$chart_ref" --version "$version"', 'existing chart content must be fetched'],
    [
      'diff -qr "$RUNNER_TEMP/published-chart/cardano-wallet-backend"',
      'existing and candidate chart content must be compared',
    ],
    [
      'echo "::error::Chart version $version already contains different chart content; bump Chart.yaml"',
      'changed chart content must fail instead of reusing a version',
    ],
  ]) {
    requireText(source, text, message)
  }
  assertInOrder(
    source,
    [
      '            if ! diff -qr "$RUNNER_TEMP/published-chart/cardano-wallet-backend"',
      '            echo "publish=false" >> "$GITHUB_OUTPUT"',
      '      - name: Publish OCI chart',
    ],
    'chart content must be compared before the publication decision',
  )
}

assertImagePublicationContract(imageWorkflow)
assertChartPublicationContract(chartWorkflow)

for (const text of [
  '      - name: Check publication gate contract',
  'TRUSTED_BASE_SHA: ${{ github.event.pull_request.base.sha }}',
  'git cat-file -e "$TRUSTED_BASE_SHA:scripts/check-publication-gate.mjs"',
  'git show "$TRUSTED_BASE_SHA:scripts/check-publication-gate.mjs"',
  'node "$RUNNER_TEMP/check-publication-gate.mjs"',
  'npm run check:publication-gate',
]) {
  requireText(ciWorkflow, text, `CI publication-check wiring missing: ${text}`)
}

// Prove that the checks reject the specific gate-removal mutations under review.
for (const marker of [
  'test "$runs" -gt 0',
  'pull: true',
  'no-cache-filters: runtime',
  '      - name: Scan the exact candidate image',
  "exit-code: '1'",
  "needs.prepare.outputs.publish == 'false' || needs.build.result == 'success'",
]) {
  assert.throws(
    () => assertImagePublicationContract(imageWorkflow.replace(marker, '')),
    /must|missing step/,
    `publication contract must reject removal of ${marker}`,
  )
}

assert.throws(
  () =>
    assertInOrder(
      'push scan smoke',
      ['scan', 'smoke', 'push'],
      'scan and smoke tests must finish before an architecture image is pushed',
    ),
  /scan and smoke tests must finish before an architecture image is pushed/,
  'publication contract must reject pushes before scan and smoke tests',
)

assert.throws(
  () =>
    assertChartPublicationContract(
      chartWorkflow.replace(
        'diff -qr "$RUNNER_TEMP/published-chart/cardano-wallet-backend"',
        'true',
      ),
    ),
  /must be compared/,
  'chart contract must reject a no-op content comparison',
)

console.log('Publication contract ok: CI, image scans, and chart content gates are enforced')
