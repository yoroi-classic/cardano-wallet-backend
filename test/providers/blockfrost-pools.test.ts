import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { MalformedUpstreamError } from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'

const POOL1 = 'pool1z5uqdk7dzdxaae5633fqfcu2eqzy3a3rgtuvy087fdld7yws0xt'
const POOL2 = 'pool19u64770wqp6s95gkajc8udheske5e6ljmpq33awxk326zjaza0q'
const POOL3 = 'pool1dvla4zq98hpvacv20snndupjrqhuc79zl6gjap565nku6et5zdx'
const HEX1 = '0f292fcaa02b8b2f9b3c8f9fd8e0bb21abedb692a6d5058df3ef2735'
const HEX2 = '2f355f79ee007502d116ecb07e36f985b34cebf2d84118f5c6b455a1'
const HEX3 = '6b3fda88053dc2cee18a7c2736f032182fcc78a2fe912e869aa4edcd'

interface PoolScript {
  extendedPages?: Record<string, unknown>[][]
  detail?: Record<string, Record<string, unknown> | { status: number }>
  metadata?: Record<string, Record<string, unknown> | { status: number }>
}

function ok(body: unknown): {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
} {
  return { ok: true, status: 200, json: async () => body, text: async () => '' }
}

function reply(answer: Record<string, unknown> | { status: number } | undefined) {
  if (answer === undefined) throw new Error('test has no answer')
  if ('status' in answer && typeof answer.status === 'number') {
    return {
      ok: answer.status < 400,
      status: answer.status,
      json: async () => ({}),
      text: async () => '',
    }
  }
  return ok(answer)
}

function providerFor(script: PoolScript): ReturnType<typeof createBlockfrostProvider> {
  const fetchImpl: FetchLike = async (url) => {
    const u = new URL(url)
    const p = u.pathname
    const page = Number(u.searchParams.get('page') ?? '1')

    if (p.endsWith('/pools/extended')) return ok((script.extendedPages ?? [])[page - 1] ?? [])
    let m = p.match(/\/pools\/([^/]+)\/metadata$/)
    if (m) return reply(script.metadata?.[decodeURIComponent(m[1] as string)])
    m = p.match(/\/pools\/([^/]+)$/)
    if (m) return reply(script.detail?.[decodeURIComponent(m[1] as string)])

    throw new Error(`test has no answer for ${url}`)
  }
  return createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })
}

function poolDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pool_id: POOL1,
    hex: HEX1,
    vrf_key: '0b5245f9934ec2151116fb8ec00f35fd00e0aa3b075c4ed12cce440f999d8233',
    blocks_minted: 69,
    blocks_epoch: 4,
    live_stake: '6900000000',
    live_size: 0.42,
    live_saturation: 0.93,
    live_delegators: 127,
    active_stake: '4200000000',
    active_size: 0.43,
    declared_pledge: '5000000000',
    live_pledge: '5000000001',
    margin_cost: 0.05,
    fixed_cost: '340000000',
    reward_account: 'stake1uxkptsa4lkr55jleztw43t37vgdn88l6ghclfwuxld2eykgpgvg3f',
    owners: ['stake1u98nnlkvkk23vtvf9273uq7cph5ww6u2yq2389psuqet90sv4xv9v'],
    registration: ['9f83e5484f543e05b52e99988272a31da373f3aab4c064c76db96643a355d9dc'],
    retirement: [],
    calidus_key: null,
    ...over,
  }
}

const POOL1_META = {
  pool_id: POOL1,
  hex: HEX1,
  url: 'https://stakenuts.com/mainnet.json',
  hash: '47c0',
  ticker: 'NUTS',
  name: 'Stake Nuts',
  description: 'The best pool ever',
  homepage: 'https://stakentus.com/',
}

function extended(
  poolId: string,
  activeStake: string,
  ticker: string | null,
): Record<string, unknown> {
  return {
    pool_id: poolId,
    active_stake: activeStake,
    metadata: ticker === null ? null : { ticker },
  }
}

describe('blockfrost pools — getPoolInfo', () => {
  it('maps a live pool with its off-chain metadata, saturation as a fraction', async () => {
    const provider = providerFor({
      detail: { [POOL1]: poolDetail() },
      metadata: { [POOL1]: POOL1_META },
    })

    const [pool] = await provider.getPoolInfo([POOL1])

    expect(pool).toEqual({
      poolId: POOL1,
      poolIdHex: HEX1,
      status: 'registered',
      margin: 0.05,
      fixedCost: '340000000',
      pledge: '5000000000',
      livePledge: '5000000001',
      activeStake: '4200000000',
      liveStake: '6900000000',
      saturation: 0.93,
      liveDelegators: 127,
      blocksMinted: 69,
      metadata: {
        name: 'Stake Nuts',
        ticker: 'NUTS',
        homepage: 'https://stakentus.com/',
        description: 'The best pool ever',
      },
    })
  })

  it('infers retired when retirements are not outnumbered by registrations', async () => {
    const provider = providerFor({
      detail: { [POOL1]: poolDetail({ registration: ['a'], retirement: ['b'] }) },
      metadata: { [POOL1]: { status: 404 } },
    })

    const [pool] = await provider.getPoolInfo([POOL1])

    expect(pool?.status).toBe('retired')
    expect(pool?.metadata).toBeUndefined()
  })

  it('omits an unknown pool (404), preserving caller order', async () => {
    const provider = providerFor({
      detail: { [POOL1]: poolDetail(), [POOL2]: { status: 404 } },
      metadata: { [POOL1]: { status: 404 } },
    })

    const pools = await provider.getPoolInfo([POOL2, POOL1])

    expect(pools.map((p) => p.poolId)).toEqual([POOL1])
  })

  it('returns [] for an empty input', async () => {
    await expect(providerFor({}).getPoolInfo([])).resolves.toEqual([])
  })

  it('throws MalformedUpstreamError on a pool hex that is not 56 hex chars', async () => {
    const provider = providerFor({ detail: { [POOL1]: poolDetail({ hex: 'nothex' }) } })

    await expect(provider.getPoolInfo([POOL1])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})

describe('blockfrost pools — getPoolList', () => {
  it('orders by active stake descending and exposes the ranking snapshot stake', async () => {
    const provider = providerFor({
      extendedPages: [
        [
          extended(POOL2, '1000000000', 'BBB'),
          extended(POOL1, '5000000000', 'AAA'),
          extended(POOL3, '3000000000', 'CCC'),
        ],
      ],
      detail: {
        [POOL1]: poolDetail({ pool_id: POOL1, hex: HEX1, active_stake: '4999999999' }),
        [POOL3]: poolDetail({ pool_id: POOL3, hex: HEX3, active_stake: '2999999999' }),
        [POOL2]: poolDetail({ pool_id: POOL2, hex: HEX2, active_stake: '999999999' }),
      },
      metadata: { [POOL1]: { status: 404 }, [POOL2]: { status: 404 }, [POOL3]: { status: 404 } },
    })

    const pools = await provider.getPoolList({ limit: 3, offset: 0 })

    expect(pools.map((p) => p.poolId)).toEqual([POOL1, POOL3, POOL2])
    // activeStake comes from the ranking snapshot (/pools/extended), not the hydrated detail.
    expect(pools.map((p) => p.activeStake)).toEqual(['5000000000', '3000000000', '1000000000'])
  })

  it('honors offset and limit', async () => {
    const provider = providerFor({
      extendedPages: [
        [
          extended(POOL1, '5000000000', 'AAA'),
          extended(POOL3, '3000000000', 'CCC'),
          extended(POOL2, '1000000000', 'BBB'),
        ],
      ],
      detail: { [POOL3]: poolDetail({ pool_id: POOL3, hex: HEX3, active_stake: '3000000000' }) },
      metadata: { [POOL3]: { status: 404 } },
    })

    const pools = await provider.getPoolList({ limit: 1, offset: 1 })

    expect(pools.map((p) => p.poolId)).toEqual([POOL3])
  })

  it('filters by ticker on the inline metadata, case-insensitively', async () => {
    const provider = providerFor({
      extendedPages: [
        [
          extended(POOL1, '5000000000', 'NUTS'),
          extended(POOL2, '1000000000', 'HODL'),
          extended(POOL3, '3000000000', null),
        ],
      ],
      detail: { [POOL1]: poolDetail({ pool_id: POOL1, hex: HEX1, active_stake: '5000000000' }) },
      metadata: { [POOL1]: POOL1_META },
    })

    const pools = await provider.getPoolList({ limit: 10, offset: 0, ticker: 'nut' })

    expect(pools.map((p) => p.poolId)).toEqual([POOL1])
    expect(pools[0]?.metadata?.ticker).toBe('NUTS')
  })

  it('scans every extended page before ranking, so a high-stake pool on a later page wins', async () => {
    const page1 = Array.from({ length: 100 }, (_v, i) =>
      extended(`pool1p1n${i}`.padEnd(20, '0'), '100', null),
    )
    const bigPool = extended(POOL1, '9000000000', 'TOP')
    const provider = providerFor({
      extendedPages: [page1, [bigPool]],
      detail: { [POOL1]: poolDetail({ pool_id: POOL1, hex: HEX1, active_stake: '9000000000' }) },
      metadata: { [POOL1]: { status: 404 } },
    })

    const pools = await provider.getPoolList({ limit: 1, offset: 0 })

    expect(pools.map((p) => p.poolId)).toEqual([POOL1])
    expect(pools[0]?.activeStake).toBe('9000000000')
  })
})
