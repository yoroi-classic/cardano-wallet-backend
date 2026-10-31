import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { MalformedUpstreamError, ProviderError } from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'
const STAKE = 'stake_test1uxrewards'
const POOL = 'pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy'

/** A fake that paginates `/accounts/{stake}/rewards` for real, honouring count and page. */
function paginatingProvider(rows: Record<string, unknown>[] | { status: number }) {
  const fetchImpl: FetchLike = async (rawUrl) => {
    const url = new URL(rawUrl)
    if (!Array.isArray(rows) && 'status' in rows) {
      return { ok: false, status: rows.status, json: async () => ({}), text: async () => '' }
    }
    const count = Number(url.searchParams.get('count') ?? '100')
    const page = Number(url.searchParams.get('page') ?? '1')
    const slice = (rows as Record<string, unknown>[]).slice((page - 1) * count, page * count)
    return { ok: true, status: 200, json: async () => slice, text: async () => '' }
  }
  return createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })
}

function reward(epoch: number, type: string, amount = '1000000', poolId: string = POOL) {
  return { epoch, amount, pool_id: poolId, type }
}

describe('blockfrost getRewardHistory — happy path', () => {
  it('maps member and leader rewards, deriving the spendable epoch and keeping the pool', async () => {
    const provider = paginatingProvider([
      reward(210, 'member', '12695385'),
      reward(211, 'leader', '500'),
    ])

    const rewards = await provider.getRewardHistory(STAKE)

    expect(rewards).toEqual([
      { earnedEpoch: 210, spendableEpoch: 212, amount: '12695385', kind: 'member', poolId: POOL },
      { earnedEpoch: 211, spendableEpoch: 213, amount: '500', kind: 'leader', poolId: POOL },
    ])
  })

  it('maps a pool deposit refund to the refund kind and drops the pool, matching Koios', async () => {
    const provider = paginatingProvider([reward(220, 'pool_deposit_refund', '500000000')])

    const rewards = await provider.getRewardHistory(STAKE)

    expect(rewards).toEqual([
      { earnedEpoch: 220, spendableEpoch: 222, amount: '500000000', kind: 'refund' },
    ])
    expect(rewards[0]).not.toHaveProperty('poolId')
  })

  it('reads across more than one page and sorts oldest-first', async () => {
    const all = Array.from({ length: 150 }, (_, i) => reward(i + 1, 'member'))
    // Hand them back shuffled within the raw set to prove the driver sorts rather than trusting order.
    const shuffled = [...all].reverse()
    const provider = paginatingProvider(shuffled)

    const rewards = await provider.getRewardHistory(STAKE)

    expect(rewards).toHaveLength(150)
    expect(rewards[0]?.earnedEpoch).toBe(1)
    expect(rewards[149]?.earnedEpoch).toBe(150)
  })

  it('pages forward on the earned epoch with afterEpoch', async () => {
    const provider = paginatingProvider([
      reward(210, 'member'),
      reward(211, 'member'),
      reward(212, 'member'),
    ])

    const rewards = await provider.getRewardHistory(STAKE, 211)

    expect(rewards.map((r) => r.earnedEpoch)).toEqual([212])
  })

  it('reports no rewards, not an error, for a stake key never seen on chain', async () => {
    const provider = paginatingProvider({ status: 404 })

    await expect(provider.getRewardHistory(STAKE)).resolves.toEqual([])
  })
})

describe('blockfrost getRewardHistory — unhappy path', () => {
  it('throws MalformedUpstreamError on a reward type outside the documented set', async () => {
    const provider = paginatingProvider([reward(210, 'staking')])

    await expect(provider.getRewardHistory(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('surfaces a non-404 upstream error', async () => {
    const provider = paginatingProvider({ status: 500 })

    await expect(provider.getRewardHistory(STAKE)).rejects.toBeInstanceOf(ProviderError)
  })
})
