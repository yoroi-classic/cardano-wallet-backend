// Protects the trust boundary between the read-only CI workflow and the
// write-enabled release workflow. Static assertions pin the GitHub Actions
// wiring; the small model below exercises the event and rerun decisions.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

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
  'git ls-remote --exit-code origin refs/heads/main',
  'delete_created_tag()',
  'git tag "$tag" "$RELEASE_SHA"',
  'git push origin "refs/tags/$tag"',
  'git push origin ":refs/tags/$tag"',
  'gh api --method POST "repos/${GITHUB_REPOSITORY}/releases"',
  '-f target_commitish="$RELEASE_SHA"',
  "--jq '.id'",
  'created_release_id=',
  'delete_created_release()',
  'release_state_by_id()',
  'release_state_for "repos/${GITHUB_REPOSITORY}/releases/$created_release_id"',
  'gh api --method DELETE',
  '"repos/${GITHUB_REPOSITORY}/releases/$created_release_id"',
  'release_state_by_tag()',
  'Refusing to delete $tag because a release currently uses it',
  'for attempt in 1 2 3',
  'delete_created_release\n            if [ "$tag_created" = true ]; then',
]) {
  assert.ok(workflow.includes(required), `release workflow contract missing: ${required}`)
}

const ignoredReleaseDeletion =
  /(?:gh release delete|gh api[^\n]*--method DELETE[^\n]*releases\/)[^\n]*\|\|\s*(?:true\b|:)/
assert.doesNotMatch(
  workflow,
  ignoredReleaseDeletion,
  'release rollback deletion must never be ignored',
)
assert.doesNotMatch(
  workflow,
  /gh release delete/,
  'release rollback must delete the captured release ID, never whichever release owns the tag',
)
for (const ignored of [
  'gh release delete "$tag" --yes ||true',
  'gh release delete "$tag" --yes ||   true',
  'gh release delete "$tag" --yes || :',
  'gh api --method DELETE "repos/o/r/releases/$created_release_id" ||\t:',
]) {
  assert.match(ignored, ignoredReleaseDeletion, `guard must reject ignored deletion: ${ignored}`)
}
assert.ok(
  workflow.indexOf('delete_created_release\n') <
    workflow.indexOf('delete_created_tag\n', workflow.indexOf('delete_created_release\n')),
  'release rollback must be reconciled before its tag is deleted',
)
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
assert.ok(
  (workflow.match(/require_current_main/g) ?? []).length >= 5,
  'release must revalidate remote main before and after each write',
)
assert.ok(
  ciWorkflow.includes('run: npm run check:release-gate'),
  'CI must invoke the shared release-gate contract script',
)
assert.equal(
  packageJson.scripts['check:release-gate'],
  'node scripts/check-release-gate.mjs',
  'package scripts must expose the release-gate contract',
)
assert.match(
  packageJson.scripts['check:ci'],
  /npm run check:release-gate/,
  'the local CI mirror must exercise the release-gate contract',
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

function raceDecision({
  currentBeforeTag,
  currentAfterTag,
  currentBeforeRelease,
  currentAfterRelease,
  tagCreated,
}) {
  if (!currentBeforeTag) return 'reject-before-tag'
  if (!currentAfterTag) return 'delete-created-tag'
  if (!currentBeforeRelease) return tagCreated ? 'delete-created-tag' : 'reject-before-release'
  if (!currentAfterRelease) {
    return tagCreated ? 'delete-release-and-created-tag' : 'delete-release'
  }
  return 'release-complete'
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
const noRace = {
  currentBeforeTag: true,
  currentAfterTag: true,
  currentBeforeRelease: true,
  currentAfterRelease: true,
  tagCreated: true,
}
assert.equal(raceDecision(noRace), 'release-complete')
assert.equal(raceDecision({ ...noRace, currentBeforeTag: false }), 'reject-before-tag')
assert.equal(raceDecision({ ...noRace, currentAfterTag: false }), 'delete-created-tag')
assert.equal(raceDecision({ ...noRace, currentBeforeRelease: false }), 'delete-created-tag')
assert.equal(
  raceDecision({ ...noRace, currentBeforeRelease: false, tagCreated: false }),
  'reject-before-release',
)
assert.equal(
  raceDecision({ ...noRace, currentAfterRelease: false }),
  'delete-release-and-created-tag',
)
assert.equal(
  raceDecision({ ...noRace, currentAfterRelease: false, tagCreated: false }),
  'delete-release',
)

console.log('Release gate contract ok: exact successful current main commit only')
