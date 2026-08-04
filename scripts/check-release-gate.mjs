// Protects the trust boundary between the read-only CI workflow and the
// write-enabled release workflow. Static assertions pin the GitHub Actions
// wiring; the small model below exercises the event and rerun decisions.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

function releaseJobCondition(source) {
  const marker = 'jobs:\n  tag:\n    if: >-\n'
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, 'release workflow must define the tag job condition')
  const body = []
  for (const line of source.slice(start + marker.length).split('\n')) {
    if (line.trim() === '') {
      body.push(line)
      continue
    }
    if (/^[ \t]{6}/.test(line)) {
      assert.match(line, /^ {6}\S/, 'release job condition has invalid indentation')
    } else if (/^[ \t]+/.test(line)) {
      break
    } else {
      break
    }
    body.push(line)
  }
  return body
    .join('\n')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.trim())
    .join(' ')
}

function releaseJobNames(source) {
  const lines = source.split('\n')
  const jobsIndex = lines.indexOf('jobs:')
  assert.notEqual(jobsIndex, -1, 'release workflow must define jobs')
  const jobs = []
  for (const line of lines.slice(jobsIndex + 1)) {
    if (line.trim() !== '' && !line.startsWith(' ')) break
    const match = /^ {2}(?:"([^"]*)"|'([^']*)'|([^\s:#][^:]*?))[ \t]*:/.exec(line)
    if (match !== null) jobs.push(match[1] ?? match[2] ?? match[3])
  }
  return jobs
}

const expectedReleaseJobCondition = [
  "github.event.workflow_run.conclusion == 'success' &&",
  "github.event.workflow_run.event == 'push' &&",
  "github.event.workflow_run.head_branch == 'main' &&",
  'github.event.workflow_run.head_repository.full_name == github.repository',
].join(' ')
function assertReleaseJobCondition(source) {
  assert.equal(
    releaseJobCondition(source),
    expectedReleaseJobCondition,
    'release job must run only for successful same-repository pushes to main',
  )
}
assertReleaseJobCondition(workflow)
assert.deepEqual(
  releaseJobNames(workflow),
  ['tag'],
  'release workflow must define only the tag job',
)
assert.throws(
  () =>
    assertReleaseJobCondition(
      workflow.replace(
        "github.event.workflow_run.conclusion == 'success' &&",
        "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.conclusion == 'failure' ||",
      ),
    ),
  /release job must run only/,
  'release gate must reject broadened job conditions',
)
assert.throws(
  () =>
    assertReleaseJobCondition(
      workflow.replace(
        'github.event.workflow_run.head_repository.full_name == github.repository\n',
        "github.event.workflow_run.head_repository.full_name == github.repository\n\n      || github.event.workflow_run.conclusion == 'failure'\n",
      ),
    ),
  /release job must run only/,
  'release gate must reject broadened folded conditions with blank lines',
)
assert.throws(
  () =>
    assertReleaseJobCondition(
      workflow.replace(
        'github.event.workflow_run.head_repository.full_name == github.repository\n',
        'github.event.workflow_run.head_repository.full_name == github.repository\n        || github.event.workflow_run.conclusion == \'failure\'\n',
      ),
    ),
  /invalid indentation|release job must run only/,
  'release gate must reject deeper-indented folded conditions',
)
assert.throws(
  () =>
    assert.deepEqual(releaseJobNames(`${workflow}\n  publish:\n    runs-on: ubuntu-latest\n`), [
      'tag',
    ]),
  /Expected values to be strictly deep-equal/,
  'release gate must reject additional release jobs',
)
assert.throws(
  () =>
    assert.deepEqual(releaseJobNames(`${workflow}\n  "publish":\n    permissions:\n      contents: write\n`), [
      'tag',
    ]),
  /Expected values to be strictly deep-equal/,
  'release gate must reject quoted additional release jobs',
)

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
  'require_release_tag()',
  'git ls-remote --exit-code origin "refs/tags/$tag" "refs/tags/$tag^{}"',
  'Tag $tag no longer exists on origin',
  'Tag $tag points to $remote_tag_sha on origin, not $RELEASE_SHA',
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
  'if [ "$release_still_valid" = false ]; then',
  'delete_created_release\n            if [ "$tag_created" = true ]; then',
]) {
  assert.ok(workflow.includes(required), `release workflow contract missing: ${required}`)
}

const workflowWithoutShellContinuations = workflow.replace(/\\[ \t]*\r?\n[ \t]*/g, ' ')
const ciWithoutComments = ciWorkflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')
assert.doesNotMatch(
  ciWithoutComments,
  /^[ \t]+continue-on-error:[ \t]*(?!false\b)[^\n]*$/im,
  'CI must not convert failed steps into a successful workflow conclusion',
)
assert.doesNotMatch(
  ciWithoutComments,
  /\|\|\s*(?:true\b|:)(?:\s*#.*)?$/m,
  'CI must not ignore failed commands',
)
const ignoredReleaseDeletion =
  /(?:gh release delete|gh api[^\n]*(?:--method|-X)\s+DELETE[^\n]*releases\/)[^\n]*\|\|\s*(?:true\b|:)/
assert.doesNotMatch(
  workflowWithoutShellContinuations,
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
  'gh api \\\n    --method DELETE \\\n    "repos/o/r/releases/$created_release_id" || true',
  'gh api -X \\\n    DELETE "repos/o/r/releases/$created_release_id" \\\n    || :',
]) {
  assert.match(
    ignored.replace(/\\[ \t]*\r?\n[ \t]*/g, ' '),
    ignoredReleaseDeletion,
    `guard must reject ignored deletion: ${ignored}`,
  )
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
  /^ {2}push:/m,
  'release must not run in parallel with CI on a main push',
)
assert.ok(
  (workflow.match(/require_current_main/g) ?? []).length >= 5,
  'release must revalidate remote main before and after each write',
)
assert.ok(
  (workflow.match(/require_release_tag/g) ?? []).length >= 4,
  'release must revalidate the remote tag immediately before and after release creation',
)
assert.match(
  workflow,
  /require_current_main\(\) \{[\s\S]*?echo "::error::Successful CI commit \$RELEASE_SHA is no longer the main head \(\$main_sha\)"\n\s+return 1[\s\S]*?\n\s+\}/,
  'require_current_main must fail closed when main moves',
)
assert.match(
  workflow,
  /if \[ "\$main_sha" != "\$RELEASE_SHA" \]; then\n\s+echo "::error::Successful CI commit \$RELEASE_SHA is no longer the main head \(\$main_sha\)"\n\s+exit 1/,
  'the initial main-head check must fail closed',
)
for (const required of [
  'fetch-depth: 0',
  'TRUSTED_BASE_SHA: ${{ github.event.pull_request.base.sha }}',
  'git cat-file -e "$TRUSTED_BASE_SHA:scripts/check-release-gate.mjs"',
  'git show "$TRUSTED_BASE_SHA:scripts/check-release-gate.mjs"',
  'node "$RUNNER_TEMP/check-release-gate.mjs"',
  'npm run check:release-gate',
]) {
  assert.ok(ciWithoutComments.includes(required), `CI release check missing: ${required}`)
}
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
