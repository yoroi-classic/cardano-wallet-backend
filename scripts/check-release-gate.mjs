// Protects the trust boundary between the read-only CI workflow and the
// write-enabled release workflow. Static assertions pin the GitHub Actions
// wiring; the small model below exercises the event and rerun decisions.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

for (const required of [
  'workflow_run:',
  'workflows: [ci]',
  'types: [completed]',
  'branches: [main]',
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'push'",
  "github.event.workflow_run.head_branch == 'main'",
  'github.event.workflow_run.head_repository.full_name == github.repository',
  'ref: ${{ github.event.workflow_run.head_sha }}',
  'RELEASE_SHA: ${{ github.event.workflow_run.head_sha }}',
  'group: release-main',
  'cancel-in-progress: false',
  'git fetch origin main --depth=1',
  'test "$(git rev-parse HEAD)" = "$RELEASE_SHA"',
  'if [ "$main_sha" != "$RELEASE_SHA" ]; then',
  'git tag "$tag" "$RELEASE_SHA"',
  'git push origin "refs/tags/$tag"',
  'gh release create "$tag" --verify-tag --target "$RELEASE_SHA"',
]) {
  assert.ok(workflow.includes(required), `release workflow contract missing: ${required}`)
}

assert.match(
  workflow,
  /permissions:\n {2}contents: read[\s\S]*?tag:[\s\S]*?permissions:\n {6}contents: write/,
  'workflow must default to read-only and grant writes only to the release job',
)
assert.doesNotMatch(
  workflow,
  /on:\n {2}push:/,
  'release must not run in parallel with CI on a main push',
)

function isEligible(event, repository) {
  return (
    event.conclusion === 'success' &&
    event.event === 'push' &&
    event.headBranch === 'main' &&
    event.headRepository === repository
  )
}

const repository = 'yoroi-classic/cardano-wallet-backend'
const successfulMainPush = {
  conclusion: 'success',
  event: 'push',
  headBranch: 'main',
  headRepository: repository,
}
assert.equal(isEligible(successfulMainPush, repository), true)
assert.equal(isEligible({ ...successfulMainPush, conclusion: 'failure' }, repository), false)
assert.equal(isEligible({ ...successfulMainPush, event: 'pull_request' }, repository), false)
assert.equal(isEligible({ ...successfulMainPush, headBranch: 'preview' }, repository), false)
assert.equal(
  isEligible({ ...successfulMainPush, headRepository: 'attacker/fork' }, repository),
  false,
)

function releaseDecision({ releaseSha, mainSha, tagSha, releaseExists }) {
  if (mainSha !== releaseSha) return 'reject-stale-main'
  if (tagSha !== undefined && tagSha !== releaseSha) return 'reject-tag-mismatch'
  if (tagSha === undefined) return releaseExists ? 'reject-release-without-tag' : 'tag-and-release'
  return releaseExists ? 'already-released' : 'create-missing-release'
}

const sha = 'a'.repeat(40)
assert.equal(
  releaseDecision({ releaseSha: sha, mainSha: sha, tagSha: undefined, releaseExists: false }),
  'tag-and-release',
)
assert.equal(
  releaseDecision({
    releaseSha: sha,
    mainSha: 'b'.repeat(40),
    tagSha: undefined,
    releaseExists: false,
  }),
  'reject-stale-main',
)
assert.equal(
  releaseDecision({
    releaseSha: sha,
    mainSha: sha,
    tagSha: 'c'.repeat(40),
    releaseExists: true,
  }),
  'reject-tag-mismatch',
)
assert.equal(
  releaseDecision({ releaseSha: sha, mainSha: sha, tagSha: sha, releaseExists: true }),
  'already-released',
)
assert.equal(
  releaseDecision({ releaseSha: sha, mainSha: sha, tagSha: sha, releaseExists: false }),
  'create-missing-release',
)

console.log('Release gate contract ok: exact successful current main commit only')
