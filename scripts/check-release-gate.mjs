// Protects the trust boundary between the read-only CI workflow and the
// write-enabled release workflow. Static assertions pin the GitHub Actions
// wiring; the small model below exercises the event and rerun decisions.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

function removeYamlComments(source) {
  return source
    .split('\n')
    .map((line) => {
      let quote
      let escaped = false
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index]
        if (escaped) {
          escaped = false
          continue
        }
        if (quote === '"' && character === '\\') {
          escaped = true
          continue
        }
        if (quote !== undefined) {
          if (character === quote) quote = undefined
          continue
        }
        if (character === '"' || character === "'") {
          quote = character
          continue
        }
        if (character === '#' && (index === 0 || /\s/.test(line[index - 1] ?? ''))) {
          return line.slice(0, index).trimEnd()
        }
      }
      return line
    })
    .join('\n')
}

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
  const parseKey = (value) => {
    const match = /^(?:"([^"]*)"|'([^']*)'|([^\s:#][^:]*?))[ \t]*$/.exec(value)
    return match?.[1] ?? match?.[2] ?? match?.[3]
  }
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    if (!line.startsWith(' ')) break
    const match = /^ {2}(?:"([^"]*)"|'([^']*)'|([^\s:#][^:]*?))[ \t]*:/.exec(line)
    if (match !== null) {
      jobs.push(match[1] ?? match[2] ?? match[3])
      continue
    }
    const explicitKey = /^ {2}\?[ \t]*(.*)$/.exec(line)
    if (explicitKey !== null) {
      const key = parseKey(explicitKey[1] ?? '')
      let nextIndex = index + 1
      while (nextIndex < lines.length) {
        const candidate = lines[nextIndex] ?? ''
        if (candidate.trim() !== '' && !/^\s*#/.test(candidate)) break
        nextIndex += 1
      }
      const next = lines[nextIndex] ?? ''
      if (key !== undefined && /^ {2}:[ \t]*/.test(next)) jobs.push(key)
    }
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
        "github.event.workflow_run.head_repository.full_name == github.repository\n        || github.event.workflow_run.conclusion == 'failure'\n",
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
    assert.deepEqual(
      releaseJobNames(`${workflow}\n  "publish":\n    permissions:\n      contents: write\n`),
      ['tag'],
    ),
  /Expected values to be strictly deep-equal/,
  'release gate must reject quoted additional release jobs',
)
assert.throws(
  () =>
    assert.deepEqual(
      releaseJobNames(`${workflow}\n  ? publish\n  :\n    runs-on: ubuntu-latest\n`),
      ['tag'],
    ),
  /Expected values to be strictly deep-equal/,
  'release gate must reject explicit additional job keys',
)
assert.throws(
  () =>
    assert.deepEqual(
      releaseJobNames(
        `${workflow}\n  ? publish\n  # comments and blank lines must not hide the value\n\n  :\n    runs-on: ubuntu-latest\n`,
      ),
      ['tag'],
    ),
  /Expected values to be strictly deep-equal/,
  'release gate must reject explicit job keys separated from their value',
)
assert.throws(
  () =>
    assert.deepEqual(
      releaseJobNames(
        `${workflow}\n# a top-level comment must not truncate jobs\n  publish:\n    runs-on: ubuntu-latest\n`,
      ),
      ['tag'],
    ),
  /Expected values to be strictly deep-equal/,
  'release gate must inspect jobs after comments',
)

const requiredWorkflowLiterals = [
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
]
function assertRequiredWorkflowLiterals(source) {
  const sourceWithoutComments = removeYamlComments(source)
  for (const required of requiredWorkflowLiterals) {
    assert.ok(
      sourceWithoutComments.includes(required),
      `release workflow contract missing: ${required}`,
    )
  }
}
assertRequiredWorkflowLiterals(workflow)

for (const safetyCall of [
  'test "$(git rev-parse HEAD)" = "$RELEASE_SHA"',
  'git fetch origin main --depth=1',
  'git tag "$tag" "$RELEASE_SHA"',
  'git push origin "refs/tags/$tag"',
  'git push origin ":refs/tags/$tag"',
  'gh api --method POST "repos/${GITHUB_REPOSITORY}/releases"',
]) {
  const line = workflow.split('\n').find((candidate) => candidate.includes(safetyCall))
  assert.ok(line, `release workflow fixture must contain safety call: ${safetyCall}`)
  const indentation = line.match(/^\s*/)?.[0] ?? ''
  const laundered = workflow.replace(line, `${indentation}# removed safety call: ${safetyCall}`)
  assert.throws(
    () => assertRequiredWorkflowLiterals(laundered),
    /release workflow contract missing:/,
    `release gate must reject comment-laundered safety call: ${safetyCall}`,
  )
}

function runBodies(source) {
  const cleaned = source
  const lines = cleaned.split('\n')
  const bodies = []
  const anchors = new Map()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    for (const match of line.matchAll(/&([A-Za-z0-9_-]+)(?:\s+([^#]+?))?(?:\s+#.*)?$/g)) {
      if (match[2] === undefined) continue
      let value = match[2].trim()
      if (/^(?:\||>)[-+]?\s*$/.test(value)) {
        const indentation = line.search(/\S/)
        for (let next = index + 1; next < lines.length; next += 1) {
          const continuation = lines[next] ?? ''
          if (continuation.trim() !== '' && continuation.search(/\S/) <= indentation) break
          value += `\n${continuation}`
        }
      }
      anchors.set(match[1], value)
    }
  }
  const stepMetadata = new Set([
    'continue-on-error',
    'env',
    'if',
    'id',
    'name',
    'shell',
    'timeout-minutes',
    'uses',
    'with',
    'working-directory',
  ])
  const isSiblingStepField = (line, indent) => {
    if (line.search(/\S/) !== indent + 2) return false
    const match = /^(?:"([^"]*)"|'([^']*)'|([A-Za-z][\w-]*))\s*:/.exec(line.slice(indent + 2))
    return match !== null && stepMetadata.has(match[1] ?? match[2] ?? match[3])
  }
  const resolveRunAlias = (value) => {
    let resolved = value
    const visited = new Set()
    while (true) {
      const alias = /^\*([A-Za-z0-9_-]+)(?:\s+#.*)?$/.exec(resolved.trim())
      if (alias === null) return resolved
      assert.ok(!visited.has(alias[1]), `CI run step uses cyclic YAML anchor: ${alias[1]}`)
      visited.add(alias[1])
      const target = anchors.get(alias[1])
      assert.ok(target, `CI run step uses unresolved YAML anchor: ${alias[1]}`)
      resolved = target
    }
  }
  const flowMapRunValues = (line) => {
    const values = []
    let open = line.indexOf('{')
    while (open !== -1) {
      let quote
      let escaped = false
      let close = -1
      for (let index = open + 1; index < line.length; index += 1) {
        const character = line[index]
        if (escaped) {
          escaped = false
          continue
        }
        if (quote !== undefined) {
          if (quote === '"' && character === '\\') escaped = true
          else if (character === quote) quote = undefined
          continue
        }
        if (character === '"' || character === "'") quote = character
        else if (character === '}') {
          close = index
          break
        }
      }
      if (close === -1) break
      const entries = []
      let entryStart = open + 1
      quote = undefined
      escaped = false
      for (let index = open + 1; index <= close; index += 1) {
        const character = line[index] ?? ','
        if (escaped) {
          escaped = false
          continue
        }
        if (quote !== undefined) {
          if (quote === '"' && character === '\\') escaped = true
          else if (character === quote) quote = undefined
          continue
        }
        if (character === '"' || character === "'") quote = character
        else if (character === ',' || index === close) {
          entries.push(line.slice(entryStart, index))
          entryStart = index + 1
        }
      }
      for (const entry of entries) {
        const match = /^(?:\s*)(?:"([^"]*)"|'([^']*)'|([A-Za-z][\w-]*))\s*:\s*(.*)$/.exec(entry)
        const key = match?.[1] ?? match?.[2] ?? match?.[3]
        if (key === 'run') values.push(resolveRunAlias(match[4] ?? ''))
      }
      open = line.indexOf('{', close + 1)
    }
    return values
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = /^(\s*)(?:-\s*)?(?:"run"|'run'|run)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const indent = (match[1] ?? '').length
    const firstLine = match[2] ?? ''
    const resolvedFirstLine = resolveRunAlias(firstLine)
    if (resolvedFirstLine !== firstLine) {
      bodies.push(resolvedFirstLine)
      continue
    }
    const body = [firstLine]
    const scalarHeader = firstLine.replace(/^((?:\||>)[-+]?)(?:\s+#.*)?$/, '$1')
    if (/^(?:\||>)[-+]?\s*$/.test(scalarHeader)) {
      for (let next = index + 1; next < lines.length; next += 1) {
        const continuation = lines[next] ?? ''
        if (continuation.trim() !== '' && continuation.search(/\S/) <= indent) break
        body.push(continuation)
        index = next
      }
    } else {
      for (let next = index + 1; next < lines.length; next += 1) {
        const continuation = lines[next] ?? ''
        if (continuation.trim() !== '' && continuation.search(/\S/) <= indent) break
        if (isSiblingStepField(continuation, indent)) break
        if (/^\s*#/.test(continuation)) continue
        body.push(continuation)
        index = next
      }
    }
    bodies.push(body.join('\n'))
  }
  for (const line of lines) bodies.push(...flowMapRunValues(line))
  return bodies
}

function continueOnErrorValues(source) {
  const values = []
  const lines = removeYamlComments(source).split('\n')
  for (const line of lines) {
    const matches = line.matchAll(
      /(?:^\s*|[,{}]\s*)(?:"continue-on-error"|'continue-on-error'|continue-on-error)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,}\s]+))/g,
    )
    for (const match of matches) values.push(match[1] ?? match[2] ?? match[3])
    const compactExplicitMatch = line.match(
      /^\s*(?:[-{},]\s*)?\?\s*(?:"continue-on-error"|'continue-on-error'|continue-on-error)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,}\s]+))/,
    )
    if (compactExplicitMatch !== null) {
      values.push(compactExplicitMatch[1] ?? compactExplicitMatch[2] ?? compactExplicitMatch[3])
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (
      !/^\s*(?:[-{},]\s*)?\?\s*(?:"continue-on-error"|'continue-on-error'|continue-on-error)\s*$/.test(
        lines[index] ?? '',
      )
    ) {
      continue
    }
    let valueIndex = index + 1
    while (valueIndex < lines.length && (lines[valueIndex] ?? '').trim() === '') {
      valueIndex += 1
    }
    const match = /^\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,}\s]+))\s*$/.exec(lines[valueIndex] ?? '')
    if (match !== null) values.push(match[1] ?? match[2] ?? match[3])
  }
  return values
}

function assertContinueOnErrorIsFalseOnly(source) {
  for (const value of continueOnErrorValues(source)) {
    assert.equal(
      value?.toLowerCase(),
      'false',
      'CI must not convert failed steps into a successful workflow conclusion',
    )
  }
}

const workflowWithoutShellContinuations = removeYamlComments(workflow).replace(
  /\\[ \t]*\r?\n[ \t]*/g,
  ' ',
)
const ciWithoutComments = removeYamlComments(ciWorkflow)
assertContinueOnErrorIsFalseOnly(ciWorkflow)
assert.deepEqual(
  continueOnErrorValues('      continue-on-error: false\n'),
  ['false'],
  'false must remain an allowed continue-on-error value',
)
assert.deepEqual(
  continueOnErrorValues('      ? continue-on-error: false\n'),
  ['false'],
  'compact explicit continue-on-error false must remain allowed',
)
for (const bypass of [
  '      continue-on-error: true\n',
  '      "continue-on-error": true\n',
  "      'continue-on-error' : true\n",
  '      - { run: npm test, continue-on-error: true }\n',
  '      ? continue-on-error: true\n',
  '      - ? continue-on-error: true\n',
  '      { ? continue-on-error: true }\n',
  '      , ? continue-on-error: true\n',
]) {
  assert.throws(
    () => assertContinueOnErrorIsFalseOnly(bypass),
    /CI must not convert failed steps/,
    `guard must reject non-false continue-on-error: ${bypass}`,
  )
}
assert.throws(
  () => assertContinueOnErrorIsFalseOnly('      ? continue-on-error\n      : true\n'),
  /CI must not convert failed steps/,
  'guard must reject explicit continue-on-error keys',
)
assert.doesNotMatch(
  runBodies(ciWorkflow).join('\n'),
  /\|\|/,
  'CI run steps must not ignore failed commands',
)
for (const ignored of [
  'run: npm test || true; echo reached',
  'run: npm test || exit 0',
  'run: |\n        npm test \\\n          || echo failed',
]) {
  assert.match(
    runBodies(ignored).join('\n'),
    /\|\|/,
    `guard must reject ignored CI command: ${ignored}`,
  )
}
assert.match(
  runBodies('      - run: npm test\n          || true\n').join('\n'),
  /\|\|/,
  'CI run guard must scan continued plain run scalars',
)
assert.doesNotMatch(
  runBodies('      - run: npm test\n        name: "metadata || true"\n').join('\n'),
  /\|\|/,
  'CI run guard must not scan sibling step metadata as shell text',
)
assert.match(
  runBodies('      run: *lint\n      value: &lint npm test || true\n').join('\n'),
  /\|\|/,
  'CI run guard must resolve run-step YAML anchors',
)
assert.match(
  runBodies(
    '      run: *outer\n      outer: &outer *base\n      base: &base npm test || true\n',
  ).join('\n'),
  /\|\|/,
  'CI run guard must resolve chained run-step YAML anchors',
)
assert.match(
  runBodies(
    '      run: *outer\n      outer: &outer *base\n      base: &base |\n        npm test || true\n',
  ).join('\n'),
  /\|\|/,
  'CI run guard must scan chained aliases targeting block scalars',
)
assert.throws(
  () => runBodies('      run: *unknown\n'),
  /unresolved YAML anchor/,
  'CI run guard must fail closed on unresolved run-step YAML anchors',
)
assert.throws(
  () => runBodies('      run: *a\n      a: &a *b\n      b: &b *a\n'),
  /cyclic YAML anchor/,
  'CI run guard must reject cyclic run-step YAML anchors',
)
assert.match(
  runBodies('      - { "run": "npm test || true" }\n').join('\n'),
  /\|\|/,
  'CI run guard must scan quoted flow-map run keys',
)
assert.match(
  runBodies('      - { name: lint, run: npm test || true }\n').join('\n'),
  /\|\|/,
  'CI run guard must scan flow-map run entries after metadata',
)
assert.match(
  runBodies('      - { "name": lint, "run": *lint }\n      value: &lint npm test || true\n').join(
    '\n',
  ),
  /\|\|/,
  'CI run guard must resolve aliased flow-map run entries after metadata',
)
assert.match(
  runBodies("      run: |\n          note='\n          keep # ' ; npm run lint || true\n").join(
    '\n',
  ),
  /\|\|/,
  'CI run guard must inspect shell continuations across YAML block-scalar lines',
)
assert.match(
  runBodies("      run: |\n          note='\n          # ' ; npm run lint || true\n").join('\n'),
  /\|\|/,
  'CI run guard must preserve comment-looking lines inside shell quotes',
)
for (const scalarHeader of ['| # explain', '> # explain']) {
  assert.match(
    runBodies(`      run: ${scalarHeader}\n          npm run lint || true\n`).join('\n'),
    /\|\|/,
    `CI run guard must scan block scalars with header comments: ${scalarHeader}`,
  )
}
const ignoredReleaseDeletion =
  /(?:gh release delete|gh api[^\n]*(?:--method|-X)\s+DELETE[^\n]*releases\/)[^\n]*\|\|/
assert.doesNotMatch(
  workflowWithoutShellContinuations,
  ignoredReleaseDeletion,
  'release rollback deletion must never be ignored',
)
assert.doesNotMatch(
  workflowWithoutShellContinuations,
  /gh release delete/,
  'release rollback must delete the captured release ID, never whichever release owns the tag',
)
for (const ignored of [
  'gh release delete "$tag" --yes ||true',
  'gh release delete "$tag" --yes || exit 0',
  'gh release delete "$tag" --yes || echo failed; echo reached',
  'gh api --method DELETE "repos/o/r/releases/$created_release_id" ||\t:',
]) {
  assert.match(
    ignored.replace(/\\[ \t]*\r?\n[ \t]*/g, ' '),
    ignoredReleaseDeletion,
    `guard must reject ignored deletion: ${ignored}`,
  )
}
function shellFunction(source, name) {
  const start = source.indexOf(`          ${name}() {`)
  assert.notEqual(start, -1, `${name} must be defined at the release step scope`)
  const lines = source.slice(start).split('\n')
  const end = lines.findIndex((line, index) => index > 0 && line === '          }')
  assert.notEqual(end, -1, `${name} must have a complete body`)
  return lines.slice(0, end + 1).join('\n')
}

const releaseWithoutComments = removeYamlComments(workflow)

function releaseStepBody(source) {
  const body = runBodies(source).find((candidate) => candidate.includes('require_current_main() {'))
  assert.ok(body, 'release step must contain its shell body')
  return body
}

function executableCallCount(source, name) {
  const callPattern = new RegExp(`^\\s+(?:if ! )?${name}(?:; then)?\\s*$`)
  return releaseStepBody(source)
    .split('\n')
    .filter((line) => callPattern.test(line)).length
}

function assertExecutableReleaseCalls(source) {
  assert.equal(
    executableCallCount(source, 'require_current_main'),
    4,
    'release must execute every current-main revalidation call',
  )
  assert.equal(
    executableCallCount(source, 'require_release_tag'),
    3,
    'release must execute every tag revalidation call',
  )
  assert.equal(
    executableCallCount(source, 'delete_created_release'),
    1,
    'release must execute its rollback release deletion call',
  )
  assert.equal(
    executableCallCount(source, 'delete_created_tag'),
    3,
    'release must execute every rollback tag deletion call',
  )
}

function assertRollbackCallsExecute(source) {
  const body = releaseStepBody(source)
  const start = body.indexOf('          if [ "$release_still_valid" = false ]; then')
  assert.notEqual(start, -1, 'release step must contain its rollback branch')
  const rollbackLines = body.slice(start).split('\n')
  const end = rollbackLines.findIndex((line, index) => index > 0 && line === '          fi')
  assert.notEqual(end, -1, 'release rollback branch must be complete')
  const rollback = rollbackLines
    .slice(0, end + 1)
    .filter((line) => line.trim() !== 'exit 1')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
  execFileSync(
    'bash',
    [
      '-eu',
      '-o',
      'pipefail',
      '-c',
      [
        'set -eu',
        'calls=',
        'delete_created_release() { calls="$calls release"; }',
        'delete_created_tag() { calls="$calls tag"; }',
        'release_still_valid=false',
        'tag_created=true',
        rollback,
        'test "$calls" = " release tag"',
      ].join('\n'),
    ],
    { stdio: 'pipe' },
  )
}

assertExecutableReleaseCalls(workflow)
assertRollbackCallsExecute(workflow)
assert.throws(
  () =>
    assertExecutableReleaseCalls(
      workflow.replace(
        '            delete_created_release\n',
        '            : delete_created_release\n',
      ),
    ),
  /release must execute its rollback release deletion call/,
  'release gate must reject prefixed rollback calls',
)
assert.throws(
  () =>
    assertExecutableReleaseCalls(
      workflow.replace(
        '              delete_created_tag\n',
        '              : delete_created_tag\n',
      ),
    ),
  /release must execute every rollback tag deletion call/,
  'release gate must reject prefixed tag rollback calls',
)
assert.throws(
  () =>
    assertRollbackCallsExecute(
      workflow.replace(
        '            delete_created_release\n',
        '            : delete_created_release\n',
      ),
    ),
  /Command failed/,
  'release gate must reject rollback branches that do not execute release deletion',
)
const currentMainFunction = shellFunction(releaseWithoutComments, 'require_current_main')
assert.equal(
  currentMainFunction,
  `          require_current_main() {
            main_sha="$(git ls-remote --exit-code origin refs/heads/main | cut -f1)"
            if [ "$main_sha" != "$RELEASE_SHA" ]; then
              echo "::error::Successful CI commit $RELEASE_SHA is no longer the main head ($main_sha)"
              return 1
            fi
          }`,
  'require_current_main must retain its executable fail-closed body',
)
assert.match(
  releaseWithoutComments,
  /test "\$\(git rev-parse HEAD\)" = "\$RELEASE_SHA"\n\s+git fetch origin main --depth=1\n\s+main_sha="\$\(git rev-parse FETCH_HEAD\)"\n\s+if \[ "\$main_sha" != "\$RELEASE_SHA" \]; then\n\s+echo "::error::Successful CI commit \$RELEASE_SHA is no longer the main head \(\$main_sha\)"\n\s+exit 1\n\s+fi/,
  'the initial main-head check must execute its failure branch',
)
assert.doesNotMatch(
  releaseWithoutComments,
  /if\s+(?:false|\[\s*false\s*\]);\s*then/,
  'release gate assertions must not be hidden behind a disabled branch',
)
const deleteFunction = shellFunction(releaseWithoutComments, 'delete_created_release')
assert.match(
  deleteFunction,
  /for attempt in 1 2 3[\s\S]*gh api --method DELETE "repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$created_release_id"/,
  'delete_created_release must execute and reconcile deletion by captured ID',
)
assert.doesNotMatch(
  deleteFunction,
  /^\s*:\s*$/m,
  'rollback deletion must not be an empty shell body',
)

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
  (releaseWithoutComments.match(/require_current_main/g) ?? []).length >= 5,
  'release must revalidate remote main before and after each write',
)
assert.ok(
  (releaseWithoutComments.match(/require_release_tag/g) ?? []).length >= 4,
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
