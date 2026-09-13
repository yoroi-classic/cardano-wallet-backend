import { describe, expect, it } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'
import { KOIOS_BODY_LIMIT_BYTES } from '../../src/providers/koios/schema.js'
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
// A real bech32 pool id is 56 characters. That length is not cosmetic here: the batch packer
// measures bytes, so a stand-in five times shorter than the real thing would make the packing
// tests measure something that does not exist. Zero padding keeps them sorted the same way the
// numbers are, which the keyset walk relies on.
function poolId(n: number): string {
  return `pool1${String(n).padStart(51, '0')}`
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
    if (url.includes('/tip')) {
      // getPoolList keys its cache on the epoch, so it reads the tip. Serving it here means the
      // tests walk the same path production does rather than a fallback one.
      rows = [{ hash: 'aa', epoch_no: 300, abs_slot: 1, block_no: 1, block_time: 1_700_000_000 }]
    } else if (url.includes('/pool_list')) {
      // Keyset paging: the provider anchors on the last pool id it saw (`pool_id_bech32=gt.x`)
      // rather than an offset, so the fake serves from after that id.
      const params = new URL(url).searchParams
      const gt = params.get('pool_id_bech32')?.replace(/^gt\./, '')
      const limit = Number(params.get('limit') ?? pageSize)
      const start =
        gt === undefined ? 0 : poolListRows.findIndex((r) => r['pool_id_bech32'] === gt) + 1
      rows = poolListRows.slice(start, start + Math.min(limit, pageSize))
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
    // The hydrated rows carry the same stakes /pool_list reported, as real ones do. The page
    // is ranked on the values it actually returns, so a fixture where the two disagree would
    // be testing a contradiction rather than the mapping.
    const { fetchImpl, calls } = routedFetch(
      [
        { pool_id_bech32: POOL_A, active_stake: '2000' },
        { pool_id_bech32: POOL_B, active_stake: '1000' },
      ],
      [
        { ...ROW_B, active_stake: '1000' },
        { ...ROW_A, active_stake: '2000' },
      ],
    )
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const pools = await provider.getPoolList({ limit: 50, offset: 0 })

    expect(pools.map((p) => p.poolId)).toEqual([POOL_A, POOL_B])
    const listCall = calls.find((c) => c.url.includes('/pool_list'))?.url ?? ''
    expect(listCall).toContain('/pool_list')
    expect(listCall).toContain('pool_status=eq.registered')
    expect(listCall).not.toContain('ticker=')
    expect(calls.some((c) => c.url === `${BASE}/pool_info`)).toBe(true)
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
    expect(new URL(listCalls[0]!.url).searchParams.get('pool_id_bech32')).toBeNull()
    expect(new URL(listCalls[1]!.url).searchParams.get('pool_id_bech32')).toBe(`gt.${poolId(999)}`)
    // The largest stake is the last row, so it is only found if page two was read.
    expect(pools.map((p) => p.poolId)).toEqual([poolId(1499)])
  })

  // Koios answers a /pool_info body carrying 100 ids with a 413, so a full page has to be
  // hydrated in chunks rather than one oversized request.
  it('packs a large page against the body budget rather than a fixed id count', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      pool_id_bech32: poolId(i),
      active_stake: String(1000 - i),
    }))
    const info = Array.from({ length: 120 }, (_, i) => poolRow(i, String(1000 - i)))
    const { fetchImpl, calls } = routedFetch(rows, info)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const pools = await provider.getPoolList({ limit: 120, offset: 0 })

    const infoCalls = calls.filter((c) => c.url.includes('/pool_info'))

    // Every body sent is inside the limit Koios documents. This is the assertion that matters,
    // and it is on the actual serialized bytes rather than on a count standing in for them.
    for (const call of infoCalls) {
      expect(Buffer.byteLength(String(call.body))).toBeLessThanOrEqual(KOIOS_BODY_LIMIT_BYTES)
    }

    // And the budget is *used*. A pool id is fixed length, so the packing is exactly computable:
    // 120 ids fit in two requests, where chunking by a fixed 50 needed three. That 1.5x here is
    // the same waste that costs 1.7x on a full page.
    expect(infoCalls).toHaveLength(2)

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

    const listCall = calls.find((c) => c.url.includes('/pool_list'))?.url ?? ''
    expect(decodeURIComponent(listCall)).toContain('ticker=ilike.*ANGEL*')
  })

  it('returns [] and skips pool_info when the page is empty', async () => {
    const { fetchImpl, calls } = routedFetch([], [ROW_A])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    expect(await provider.getPoolList({ limit: 50, offset: 0 })).toEqual([])
    // No hydration for an empty page. Asserted on the *absence of a /pool_info call* rather than
    // on a total call count, because a count also changes when an unrelated call is added (the
    // tip read that keys the cache), and that would say nothing about whether we hydrated.
    expect(calls.filter((c) => c.url.includes('/pool_info'))).toHaveLength(0)
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
  it('pages by keyset, not offset, so a pool retiring mid-walk cannot slide the window', async () => {
    // An offset counts rows from the start on every request. If a pool leaves the list while
    // the walk is in flight, the tail slides up by one and the next offset page skips a pool
    // that was never read. Anchoring on the last id seen survives that.
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
    expect(listCalls.length).toBeGreaterThan(1)
    // First page has no cursor; every page after it anchors on the last id of the one before.
    expect(new URL(listCalls[0]!.url).searchParams.get('pool_id_bech32')).toBeNull()
    expect(new URL(listCalls[1]!.url).searchParams.get('pool_id_bech32')).toBe(`gt.${poolId(999)}`)
    for (const call of listCalls) {
      expect(new URL(call.url).searchParams.get('offset')).toBeNull()
    }
  })

  it('reads a list that ends exactly on the cap boundary without failing it', async () => {
    // 20 full pages and nothing after them is a complete read, not a truncated one. Failing
    // here would reject a request that actually succeeded, so the cap is probed rather than
    // assumed.
    const listRows = Array.from({ length: 20_000 }, (_, i) => ({
      pool_id_bech32: poolId(i),
      active_stake: '1',
    }))
    const infoRows = listRows.slice(0, 5).map((r) => ({
      ...ROW_A,
      pool_id_bech32: r.pool_id_bech32 as string,
    }))
    const { fetchImpl } = routedFetch(listRows, infoRows, 1000)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getPoolList({ limit: 5, offset: 0 })).resolves.toHaveLength(5)
  })

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

describe('koios getPoolList — one ranking snapshot, not one per page', () => {
  it('reports the activeStake it actually ranked on, so the page is descending', async () => {
    // Hydration is a second round trip and across an epoch boundary it is a different
    // snapshot. Ranking on /pool_list but exposing /pool_info's stake would send back a page
    // whose own activeStake values are not descending while claiming to be sorted by them.
    const listRows = [
      { pool_id_bech32: poolId(1), active_stake: '3000' },
      { pool_id_bech32: poolId(2), active_stake: '2000' },
      { pool_id_bech32: poolId(3), active_stake: '1000' },
    ]
    // The epoch ticked over: hydration reports a different, differently-ordered snapshot.
    const infoRows = [
      { ...ROW_A, pool_id_bech32: poolId(1), active_stake: '1500' },
      { ...ROW_A, pool_id_bech32: poolId(2), active_stake: '9000' },
      { ...ROW_A, pool_id_bech32: poolId(3), active_stake: '4000' },
    ]
    const { fetchImpl } = routedFetch(listRows, infoRows)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const pools = await provider.getPoolList({ limit: 3, offset: 0 })

    expect(pools.map((p) => p.poolId)).toEqual([poolId(1), poolId(2), poolId(3)])
    expect(pools.map((p) => p.activeStake)).toEqual(['3000', '2000', '1000'])
    for (let i = 1; i < pools.length; i += 1) {
      expect(BigInt(pools[i - 1]!.activeStake) >= BigInt(pools[i]!.activeStake)).toBe(true)
    }
  })

  it('keeps adjacent pages in order relative to each other', async () => {
    // Re-ranking each page on its hydrated values would make each page locally tidy and the
    // sequence globally scrambled: membership is still chosen from the snapshot, so page 2
    // could outrank page 1. Every page has to be cut from the one ranking.
    const listRows = Array.from({ length: 6 }, (_, i) => ({
      pool_id_bech32: poolId(i),
      active_stake: String(6000 - i * 1000),
    }))
    // Hydration disagrees, and in the reverse order.
    const infoRows = listRows.map((r, i) => ({
      ...ROW_A,
      pool_id_bech32: r.pool_id_bech32,
      active_stake: String(1000 + i * 1000),
    }))
    const { fetchImpl } = routedFetch(listRows, infoRows)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const first = await provider.getPoolList({ limit: 3, offset: 0 })
    const second = await provider.getPoolList({ limit: 3, offset: 3 })

    const lastOfFirst = BigInt(first[first.length - 1]!.activeStake)
    const firstOfSecond = BigInt(second[0]!.activeStake)
    expect(lastOfFirst >= firstOfSecond).toBe(true)
    expect([...first, ...second].map((p) => p.poolId)).toEqual(
      Array.from({ length: 6 }, (_, i) => poolId(i)),
    )
  })

  it('ties a null active_stake with a real zero and breaks on pool id', async () => {
    // mapPoolInfo normalizes a null stake to '0' on the way out, so ranking it below a real
    // zero would produce an order the exposed values cannot explain.
    const listRows = [
      { pool_id_bech32: poolId(9), active_stake: null },
      { pool_id_bech32: poolId(4), active_stake: '0' },
    ]
    const infoRows = listRows.map((r) => ({
      ...ROW_A,
      pool_id_bech32: r.pool_id_bech32,
      active_stake: r.active_stake,
    }))
    const { fetchImpl } = routedFetch(listRows, infoRows)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const pools = await provider.getPoolList({ limit: 50, offset: 0 })

    expect(pools.map((p) => p.activeStake)).toEqual(['0', '0'])
    expect(pools.map((p) => p.poolId)).toEqual([poolId(4), poolId(9)])
  })
})
