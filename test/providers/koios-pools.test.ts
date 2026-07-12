import { describe, expect, it } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'
import { MalformedUpstreamError, ProviderError } from '../../src/domain/errors.js'

const BASE = 'https://preprod.koios.rest/api/v1'
const POOL_A = 'pool1wn6a6f23ctq06udwhw27ravdpd6zcr7jlut3yez0wzdackz3222'
const POOL_B = 'pool174mw7e20768e8vj4fn8y6p536n8rkzswsapwtwn354dckpjqzr8'

interface Call {
  url: string
  method?: string
  body?: string | Uint8Array
}

function fakeFetch(json: () => Promise<unknown>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body })
    return { ok: true, status: 200, json, text: async () => '' }
  }
  return { fetchImpl, calls }
}

// Shaped after a live Koios preprod /pool_info row.
const ROW_A = {
  pool_id_bech32: POOL_A,
  pool_id_hex: '74f5dd2551c2c0fd71aebb95e1f58d0b742c0fd2ff1712644f709bdc',
  pool_status: 'registered',
  retiring_epoch: null,
  margin: 0.22,
  fixed_cost: '777000000',
  pledge: '44400000000',
  live_pledge: '261113197656',
  active_stake: '1990584779091',
  live_stake: '1995704621789',
  live_saturation: 3.12,
  live_delegators: 104,
  block_count: 24497,
  meta_json: {
    name: 'ANGEL stake pool',
    ticker: 'ANGEL',
    homepage: 'https://www.angelstakepool.net',
    description: 'ANGEL pool at pre-production',
  },
}

describe('koios getPoolInfo', () => {
  it('maps a full pool row and posts the bech32 ids', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [ROW_A])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [pool] = await provider.getPoolInfo([POOL_A])

    // 3.12% saturation normalized to a fraction (checked separately for float precision).
    expect(pool?.saturation).toBeCloseTo(0.0312, 12)
    expect({ ...pool, saturation: 0 }).toEqual({
      poolId: POOL_A,
      poolIdHex: '74f5dd2551c2c0fd71aebb95e1f58d0b742c0fd2ff1712644f709bdc',
      status: 'registered',
      retiringEpoch: undefined,
      margin: 0.22,
      fixedCost: '777000000',
      pledge: '44400000000',
      livePledge: '261113197656',
      activeStake: '1990584779091',
      liveStake: '1995704621789',
      saturation: 0,
      liveDelegators: 104,
      blocksMinted: 24497,
      metadata: {
        name: 'ANGEL stake pool',
        ticker: 'ANGEL',
        homepage: 'https://www.angelstakepool.net',
        description: 'ANGEL pool at pre-production',
      },
    })
    expect(calls[0]?.url).toBe(`${BASE}/pool_info`)
    expect(calls[0]?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ _pool_bech32_ids: [POOL_A] })
  })

  it('returns pools in the caller order and omits unknown ids', async () => {
    // Koios responds unordered and without a row for an unknown pool.
    const { fetchImpl } = fakeFetch(async () => [
      { ...ROW_A, pool_id_bech32: POOL_B, pool_id_hex: 'b'.repeat(56), meta_json: null },
      ROW_A,
    ])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const pools = await provider.getPoolInfo([POOL_A, 'pool1unknown', POOL_B])

    expect(pools.map((p) => p.poolId)).toEqual([POOL_A, POOL_B])
  })

  it('defaults nullable stats and drops absent metadata', async () => {
    const { fetchImpl } = fakeFetch(async () => [
      {
        pool_id_bech32: POOL_A,
        pool_id_hex: 'c'.repeat(56),
        pool_status: 'retiring',
        retiring_epoch: 130,
        margin: 0,
        fixed_cost: null,
        pledge: null,
        live_pledge: null,
        active_stake: null,
        live_stake: null,
        live_saturation: null,
        live_delegators: null,
        block_count: null,
        meta_json: null,
      },
    ])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [pool] = await provider.getPoolInfo([POOL_A])

    expect(pool).toEqual({
      poolId: POOL_A,
      poolIdHex: 'c'.repeat(56),
      status: 'retiring',
      retiringEpoch: 130,
      margin: 0,
      fixedCost: '0',
      pledge: '0',
      livePledge: '0',
      activeStake: '0',
      liveStake: '0',
      saturation: 0,
      liveDelegators: 0,
      blocksMinted: 0,
      metadata: undefined,
    })
  })

  it('keeps only the metadata fields the pool actually registered', async () => {
    const { fetchImpl } = fakeFetch(async () => [
      { ...ROW_A, meta_json: { ticker: 'ONLY', name: null, homepage: null, description: null } },
    ])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [pool] = await provider.getPoolInfo([POOL_A])

    expect(pool?.metadata).toEqual({ ticker: 'ONLY' })
  })

  it('returns [] without calling upstream for an empty batch', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [ROW_A])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    expect(await provider.getPoolInfo([])).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('rejects an unexpected pool_status as malformed upstream', async () => {
    const { fetchImpl } = fakeFetch(async () => [{ ...ROW_A, pool_status: 'gone' }])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getPoolInfo([POOL_A])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})

const ROW_B = { ...ROW_A, pool_id_bech32: POOL_B, pool_id_hex: 'b'.repeat(56), meta_json: null }

// A pool id is only ever compared for equality here, so a synthetic one is enough.
function poolId(n: number): string {
  return `pool1${String(n).padStart(6, '0')}`
}

function poolRow(n: number, activeStake: string | null): Record<string, unknown> {
  return {
    ...ROW_A,
    pool_id_bech32: poolId(n),
    pool_id_hex: String(n).padStart(56, 'f'),
    active_stake: activeStake,
  }
}

// Routes /pool_list and /pool_info to different canned responses since getPoolList calls
// both, and serves /pool_list in Koios-sized pages so the provider's paging is exercised.
// /pool_info answers from whatever ids the request body asked for, like the real endpoint.
function routedFetch(
  poolListRows: Array<Record<string, unknown>>,
  poolInfoRows: Array<Record<string, unknown>>,
  pageSize = 1000,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body })
    let rows: unknown
    if (url.includes('/pool_list')) {
      const offset = Number(new URL(url).searchParams.get('offset') ?? 0)
      rows = poolListRows.slice(offset, offset + pageSize)
    } else {
      const asked = new Set(
        (JSON.parse(String(init?.body ?? '{}')) as { _pool_bech32_ids?: string[] })
          ._pool_bech32_ids ?? [],
      )
      rows = poolInfoRows.filter((r) => asked.has(r['pool_id_bech32'] as string))
    }
    return { ok: true, status: 200, json: async () => rows, text: async () => '' }
  }
  return { fetchImpl, calls }
}

describe('koios getPoolList', () => {
  it('hydrates the requested page with pool info, in order', async () => {
    const { fetchImpl, calls } = routedFetch(
      [
        { pool_id_bech32: POOL_A, active_stake: '2000' },
        { pool_id_bech32: POOL_B, active_stake: '1000' },
      ],
      [ROW_B, ROW_A],
    )
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const pools = await provider.getPoolList({ limit: 50, offset: 0 })

    expect(pools.map((p) => p.poolId)).toEqual([POOL_A, POOL_B])
    const listCall = calls[0]?.url ?? ''
    expect(listCall).toContain('/pool_list')
    expect(listCall).toContain('pool_status=eq.registered')
    expect(listCall).not.toContain('ticker=')
    expect(calls[1]?.url).toBe(`${BASE}/pool_info`)
  })

  // Regression: Koios stores active_stake as text, so ordering on it upstream sorts
  // lexicographically and puts a 10-digit stake above a 13-digit one. These are the real
  // preprod values that exposed it. The sort has to be numeric, and ours is.
  it('orders by active stake numerically, not lexicographically', async () => {
    const { fetchImpl } = routedFetch(
      [
        { pool_id_bech32: poolId(1), active_stake: '9998813687' },
        { pool_id_bech32: poolId(2), active_stake: '7682048683977' },
        { pool_id_bech32: poolId(3), active_stake: '99632441' },
        { pool_id_bech32: poolId(4), active_stake: '6813346542156' },
      ],
      [
        poolRow(1, '9998813687'),
        poolRow(2, '7682048683977'),
        poolRow(3, '99632441'),
        poolRow(4, '6813346542156'),
      ],
    )
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const pools = await provider.getPoolList({ limit: 50, offset: 0 })

    expect(pools.map((p) => p.poolId)).toEqual([poolId(2), poolId(4), poolId(1), poolId(3)])
  })

  it('sorts pools with no active stake last', async () => {
    const { fetchImpl } = routedFetch(
      [
        { pool_id_bech32: poolId(1), active_stake: null },
        { pool_id_bech32: poolId(2), active_stake: '5' },
      ],
      [poolRow(1, null), poolRow(2, '5')],
    )
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const pools = await provider.getPoolList({ limit: 50, offset: 0 })

    expect(pools.map((p) => p.poolId)).toEqual([poolId(2), poolId(1)])
  })

  // Equal stakes must break on a stable key, or a pool could be served on two pages, or on
  // neither, as the upstream row order shifts between the two calls.
  it('breaks ties on pool id so paging is stable', async () => {
    const rows = [poolId(3), poolId(1), poolId(2)].map((id) => ({
      pool_id_bech32: id,
      active_stake: '100',
    }))
    const info = [poolRow(1, '100'), poolRow(2, '100'), poolRow(3, '100')]
    const provider = createKoiosProvider({
      baseUrl: BASE,
      fetchImpl: routedFetch(rows, info).fetchImpl,
    })

    const first = await provider.getPoolList({ limit: 2, offset: 0 })
    const second = await provider.getPoolList({ limit: 2, offset: 2 })

    expect(first.map((p) => p.poolId)).toEqual([poolId(1), poolId(2)])
    expect(second.map((p) => p.poolId)).toEqual([poolId(3)])
  })

  it('applies offset and limit to the sorted set', async () => {
    const stakes = ['300', '100', '500', '400', '200']
    const { fetchImpl } = routedFetch(
      stakes.map((s, i) => ({ pool_id_bech32: poolId(i), active_stake: s })),
      stakes.map((s, i) => poolRow(i, s)),
    )
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const pools = await provider.getPoolList({ limit: 2, offset: 1 })

    // Sorted: 500, 400, 300, 200, 100 -> offset 1, limit 2 -> 400, 300.
    expect(pools.map((p) => p.poolId)).toEqual([poolId(3), poolId(0)])
  })

  // Koios caps a response at 1000 rows, and mainnet has ~3k registered pools. A page-sized
  // response means there is more to read, so the provider has to follow the paging.
  it('follows koios paging until a short page ends the walk', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({
      pool_id_bech32: poolId(i),
      active_stake: String(i + 1),
    }))
    const { fetchImpl, calls } = routedFetch(rows, [poolRow(1499, '1500')])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const pools = await provider.getPoolList({ limit: 1, offset: 0 })

    const listCalls = calls.filter((c) => c.url.includes('/pool_list'))
    expect(listCalls).toHaveLength(2)
    expect(listCalls[0]?.url).toContain('offset=0')
    expect(listCalls[1]?.url).toContain('offset=1000')
    // The largest stake is the last row, so it is only found if page two was read.
    expect(pools.map((p) => p.poolId)).toEqual([poolId(1499)])
  })

  // Koios answers a /pool_info body carrying 100 ids with a 413, so a full page has to be
  // hydrated in chunks rather than one oversized request.
  it('hydrates a large page in chunks of 50 ids', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      pool_id_bech32: poolId(i),
      active_stake: String(1000 - i),
    }))
    const info = Array.from({ length: 120 }, (_, i) => poolRow(i, String(1000 - i)))
    const { fetchImpl, calls } = routedFetch(rows, info)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const pools = await provider.getPoolList({ limit: 120, offset: 0 })

    const infoCalls = calls.filter((c) => c.url.includes('/pool_info'))
    expect(infoCalls).toHaveLength(3)
    for (const call of infoCalls) {
      const ids = (JSON.parse(String(call.body)) as { _pool_bech32_ids: string[] })._pool_bech32_ids
      expect(ids.length).toBeLessThanOrEqual(50)
    }
    // Every pool still comes back, in stake order, stitched across the chunks.
    expect(pools).toHaveLength(120)
    expect(pools.map((p) => p.poolId)).toEqual(rows.map((r) => r.pool_id_bech32))
  })

  it('adds a ticker ilike filter when a ticker is given', async () => {
    const { fetchImpl, calls } = routedFetch(
      [{ pool_id_bech32: POOL_A, active_stake: '1' }],
      [ROW_A],
    )
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await provider.getPoolList({ limit: 10, offset: 5, ticker: 'ANGEL' })

    const listCall = calls[0]?.url ?? ''
    expect(decodeURIComponent(listCall)).toContain('ticker=ilike.*ANGEL*')
  })

  it('returns [] and skips pool_info when the page is empty', async () => {
    const { fetchImpl, calls } = routedFetch([], [ROW_A])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    expect(await provider.getPoolList({ limit: 50, offset: 0 })).toEqual([])
    // Only the pool_list call happened; no hydration for an empty page.
    expect(calls).toHaveLength(1)
  })
})

describe('koios getPoolInfo — upstream value integrity', () => {
  it('rejects a margin outside [0, 1]', async () => {
    // An operator margin is a fraction of rewards by definition. A value outside the range
    // is upstream junk, and passing it through would let a UI show a 220% fee as fact.
    const { fetchImpl } = fakeFetch(async () => [{ ...ROW_A, margin: 2.2 }])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getPoolInfo([POOL_A])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects a fractional delegator count', async () => {
    const { fetchImpl } = fakeFetch(async () => [{ ...ROW_A, live_delegators: 10.5 }])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getPoolInfo([POOL_A])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects a negative block count', async () => {
    const { fetchImpl } = fakeFetch(async () => [{ ...ROW_A, block_count: -1 }])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getPoolInfo([POOL_A])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})

describe('koios getPoolList — the upstream walk is ordered and honest', () => {
  it('asks Koios for a deterministic row order while paging', async () => {
    // A limit/offset walk with no ORDER BY has no defined row order upstream: pages can
    // overlap or leave gaps, so a pool gets served twice or is never seen at all. The stake
    // sort still has to happen locally, because active_stake is a text column upstream.
    const listRows = Array.from({ length: 1200 }, (_, i) => ({
      pool_id_bech32: poolId(i),
      active_stake: String(1200 - i),
    }))
    const infoRows = listRows.map((r) => ({
      ...ROW_A,
      pool_id_bech32: r.pool_id_bech32 as string,
      active_stake: r.active_stake as string,
    }))
    const { fetchImpl, calls } = routedFetch(listRows, infoRows, 1000)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await provider.getPoolList({ limit: 5, offset: 0 })

    const listCalls = calls.filter((c) => c.url.includes('/pool_list'))
    expect(listCalls.length).toBeGreaterThan(0)
    for (const call of listCalls) {
      expect(new URL(call.url).searchParams.get('order')).toBe('pool_id_bech32.asc')
    }
  })

  it('refuses to rank a truncated set as if it were the whole set', async () => {
    // Every page of this endpoint is cut from the sorted whole, so a truncated read does not
    // merely shorten the tail: a missed pool with large stake would be absent from page one.
    const listRows = Array.from({ length: 25_000 }, (_, i) => ({
      pool_id_bech32: poolId(i),
      active_stake: '1',
    }))
    const { fetchImpl } = routedFetch(listRows, [], 1000)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getPoolList({ limit: 5, offset: 0 })).rejects.toBeInstanceOf(
      ProviderError,
    )
  })
})
