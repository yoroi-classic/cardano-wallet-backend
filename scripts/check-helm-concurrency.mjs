// Keeps Helm validation cancellation independent from the queued publication
// path. This checks the workflow wiring and simulates the key properties that
// prevent rapid main pushes from superseding one another.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflowPath = '.github/workflows/helm-chart.yml'
const workflow = readFileSync(workflowPath, 'utf8')
const validationStart = workflow.indexOf('  cardano-wallet-backend:')
const publishStart = workflow.indexOf('\n  publish:')

assert.notEqual(validationStart, -1, 'Helm validation job is missing')
assert.notEqual(publishStart, -1, 'Helm publication job is missing')
assert.ok(publishStart > validationStart, 'Helm publication must follow validation')

const validationJob = workflow.slice(validationStart, publishStart)
const publishJob = workflow.slice(publishStart)
const groupExpression =
  "group: helm-chart-validate-${{ github.ref == 'refs/heads/main' && format('main-{0}', github.run_id) || github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref }}"
const cancelExpression = "cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}"

assert.ok(validationJob.includes(groupExpression), 'Helm validation concurrency group changed')
assert.ok(validationJob.includes(cancelExpression), 'Helm validation cancellation policy changed')
assert.ok(publishJob.includes('group: helm-chart-publish-main'), 'main publication group changed')
assert.ok(
  publishJob.includes('queue: max'),
  'main publication must remain queued without cancellation',
)

function validationPolicy({ eventName, pullRequestNumber, ref, runId }) {
  if (ref === 'refs/heads/main') {
    return { cancelInProgress: false, group: `helm-chart-validate-main-${runId}` }
  }
  if (eventName === 'pull_request') {
    return { cancelInProgress: true, group: `helm-chart-validate-pr-${pullRequestNumber}` }
  }
  return { cancelInProgress: true, group: `helm-chart-validate-${ref}` }
}

const prFirst = validationPolicy({
  eventName: 'pull_request',
  pullRequestNumber: 87,
  ref: 'refs/pull/87/merge',
  runId: 1001,
})
const prSecond = validationPolicy({
  eventName: 'pull_request',
  pullRequestNumber: 87,
  ref: 'refs/pull/87/merge',
  runId: 1002,
})
assert.equal(prFirst.group, prSecond.group, 'updates to one PR must share a validation group')
assert.equal(prSecond.cancelInProgress, true, 'PR validation must cancel superseded work')

const branchFirst = validationPolicy({
  eventName: 'push',
  ref: 'refs/heads/development',
  runId: 2001,
})
const branchSecond = validationPolicy({
  eventName: 'push',
  ref: 'refs/heads/development',
  runId: 2002,
})
assert.equal(
  branchFirst.group,
  branchSecond.group,
  'one non-main branch must share a validation group',
)
assert.equal(branchSecond.cancelInProgress, true, 'non-main validation must cancel superseded work')

const mainFirst = validationPolicy({ eventName: 'push', ref: 'refs/heads/main', runId: 3001 })
const mainSecond = validationPolicy({ eventName: 'push', ref: 'refs/heads/main', runId: 3002 })
assert.notEqual(mainFirst.group, mainSecond.group, 'main validation runs must never collide')
assert.equal(mainFirst.cancelInProgress, false, 'main validation must not be canceled')
assert.equal(mainSecond.cancelInProgress, false, 'main validation must not be canceled')

console.log(
  'Helm concurrency policy ok: PR/branch validation cancels; main validation and publish queue',
)
