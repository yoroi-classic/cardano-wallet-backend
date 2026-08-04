import { describe, expect, it } from 'vitest'
import {
  createGeckoTerminalClient,
  DEFAULT_GECKOTERMINAL_BASE_URL,
} from '../../src/prices/geckoterminal.js'
import type { FetchLike } from '../../src/prices/http.js'
import type { TokenBucket } from '../../src/prices/rate-limit.js'
import { createMemoryCache } from '../../src/cache/index.js'
import {
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../../src/domain/errors.js'

const SUBJECT = 'cafe'.repeat(14) // 56 hex chars, shaped like a policy id; the value doesn't matter
const HEALTHY_SUBJECT = 'beef'.repeat(14)
const NATIVE_ID = 'cardano_0x'

interface FakeResponse {
  status?: number
  json?: unknown
}

/** Route a fake fetch by a substring of the path, recording every URL it was called with. */
function fakeFetch(responses: Record<string, FakeResponse>): {
  fetchImpl: FetchLike
  urls: string[]
} {
  const urls: string[] = []
  const fetchImpl: FetchLike = (async (url: string) => {
    urls.push(url)
    const key = Object.keys(responses).find((k) => url.includes(k))
    const response = key !== undefined ? responses[key] : undefined
    const status = response?.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response?.json ?? {},
      text: async () => JSON.stringify(response?.json ?? {}),
    }
  }) as FetchLike
  return { fetchImpl, urls }
}

/**
 * One pool entry, shaped like GeckoTerminal's own response for a token's pool list.
 *
 * `changeH24`/`volumeH24` default to a realistic value, since most tests aren't about the 24h
 * fields at all; pass `null` explicitly to omit them, for the one test that is.
 */
function pool(opts: {
  baseId?: string
  quoteId?: string
  reserveUsd?: string
  priceNative?: string
  quoteUsd?: string
  changeH24?: string | null
  volumeH24?: string | null
  address?: string
}) {
  const changeH24 = opts.changeH24 === undefined ? '2.881' : opts.changeH24
  const volumeH24 = opts.volumeH24 === undefined ? '96650.3017183848' : opts.volumeH24
  return {
    attributes: {
      address: opts.address ?? 'pool-address',
      base_token_price_native_currency: opts.priceNative ?? '0.184256164011507',
      quote_token_price_usd: opts.quoteUsd ?? '0.163485',
      reserve_in_usd: opts.reserveUsd ?? '2312217.865',
      ...(changeH24 === null ? {} : { price_change_percentage: { h24: changeH24 } }),
      ...(volumeH24 === null ? {} : { volume_usd: { h24: volumeH24 } }),
    },
    relationships: {
      base_token: { data: { id: opts.baseId ?? `cardano_${SUBJECT}` } },
      quote_token: { data: { id: opts.quoteId ?? NATIVE_ID } },
    },
  }
}

const ADA_POOL = pool({})

function poolsResponse(...pools: ReturnType<typeof pool>[]) {
  return { data: pools }
}

/**
 * The `/tokens/multi/{addresses}?include=top_pools` response: each token's pools are inlined under
 * `included` and referenced from its `top_pools` relationship, exactly as that endpoint returns.
 */
function multiResponse(...entries: Array<{ subject: string; pools: ReturnType<typeof pool>[] }>) {
  const included: unknown[] = []
  const data = entries.map(({ subject, pools }, entryIdx) => {
    const refs = pools.map((p, i) => {
      const id = `pool_${entryIdx}_${i}`
      included.push({ id, ...p })
      return { id }
    })
    return { attributes: { address: subject }, relationships: { top_pools: { data: refs } } }
  })
  return { data, included }
}

function client(cache?: ReturnType<typeof createMemoryCache>, fetchImpl?: FetchLike) {
  return createGeckoTerminalClient({ cache, fetchImpl })
}

describe('geckoterminal client — happy path (24h)', () => {
  it('computes price, change and volume-in-ADA from the pool, with one upstream call', async () => {
    const { fetchImpl, urls } = fakeFetch({
      '/tokens/multi/': { json: multiResponse({ subject: SUBJECT, pools: [ADA_POOL] }) },
    })

    const [activity] = await client(undefined, fetchImpl).getTokenActivity([SUBJECT], '24h')

    expect(activity).toEqual({
      subject: SUBJECT,
      priceAda: '0.184256164011507',
      changePercent: 2.881,
      // 96650.3017183848 / 0.163485, formatted as a plain decimal string.
      volumeAda: '591187.5812361061',
    })
    // A single batched multi-token call resolves the whole request, ADA quote and 24h figures.
    expect(urls).toHaveLength(1)
    expect(urls[0]).toBe(
      `${DEFAULT_GECKOTERMINAL_BASE_URL}/networks/cardano/tokens/multi/${SUBJECT}?include=top_pools`,
    )
  })

  it('picks the most liquid ADA-paired pool, falling back past a bigger non-ADA top pool', async () => {
    const smallAdaPool = pool({ reserveUsd: '100', priceNative: '0.01', address: 'small-ada' })
    const bigNonAdaPool = pool({
      reserveUsd: '999999',
      quoteId: 'cardano_deadbeef',
      priceNative: '0.02',
      address: 'big-non-ada',
    })
    const bigAdaPool = pool({ reserveUsd: '5000000', priceNative: '0.03', address: 'big-ada' })
    const { fetchImpl } = fakeFetch({
      // The multi endpoint's single top pool is the non-ADA one, so this token falls back to its
      // full pool list, where the most-liquid ADA pair is chosen.
      '/tokens/multi/': { json: multiResponse({ subject: SUBJECT, pools: [bigNonAdaPool] }) },
      [`/tokens/${SUBJECT}/pools`]: {
        json: poolsResponse(smallAdaPool, bigNonAdaPool, bigAdaPool),
      },
    })

    const [activity] = await client(undefined, fetchImpl).getTokenActivity([SUBJECT], '24h')

    // Ignores the higher-reserve non-ADA pool entirely, and the smaller ADA pool.
    expect(activity?.priceAda).toBe('0.03')
  })

  it('caches the resolved pool, so activity and history for the same subject share one lookup', async () => {
    const { fetchImpl, urls } = fakeFetch({
      '/tokens/multi/': { json: multiResponse({ subject: SUBJECT, pools: [ADA_POOL] }) },
      '/ohlcv/day': { json: { data: { attributes: { ohlcv_list: [] } } } },
    })
    const cache = createMemoryCache()
    const provider = client(cache, fetchImpl)

    await provider.getTokenActivity([SUBJECT], '24h')
    await provider.getTokenHistory(SUBJECT, '6m')

    // Activity resolves and caches the pool via the multi endpoint; history reuses it from cache
    // and only fetches candles, never a second pool lookup. (The `multi` path is the only /tokens/
    // call; the OHLCV path lives under /pools/.)
    expect(urls.filter((u) => u.includes('/tokens/'))).toHaveLength(1)
  })
})

describe('geckoterminal client — happy path (7d/30d)', () => {
  // Newest first, as GeckoTerminal itself returns them: today's candle closes at 0.20, and the
  // oldest (7 days back) opened at 0.10.
  const DAILY_CANDLES_7D = [
    [700_000_600, 0.2, 0.21, 0.19, 0.2, 1000],
    [700_000_500, 0.19, 0.2, 0.18, 0.2, 1000],
    [700_000_400, 0.18, 0.19, 0.17, 0.19, 1000],
    [700_000_300, 0.17, 0.18, 0.16, 0.18, 1000],
    [700_000_200, 0.16, 0.17, 0.15, 0.17, 1000],
    [700_000_100, 0.12, 0.16, 0.11, 0.16, 1000],
    [700_000_000, 0.1, 0.13, 0.09, 0.12, 1000],
  ]

  it('derives price, change and volume from daily candles, not from the pool object', async () => {
    const { fetchImpl, urls } = fakeFetch({
      '/tokens/multi/': { json: multiResponse({ subject: SUBJECT, pools: [ADA_POOL] }) },
      '/ohlcv/day': { json: { data: { attributes: { ohlcv_list: DAILY_CANDLES_7D } } } },
    })

    const [activity] = await client(undefined, fetchImpl).getTokenActivity([SUBJECT], '7d')

    expect(activity).toEqual({
      subject: SUBJECT,
      priceAda: '0.2', // the newest candle's close
      changePercent: 100, // (0.20 - 0.10) / 0.10 * 100
      volumeAda: '7000', // 7 candles at 1000 each
    })
    const ohlcvUrl = urls.find((u) => u.includes('/ohlcv/day'))
    expect(ohlcvUrl).toContain('aggregate=1')
    expect(ohlcvUrl).toContain('limit=7')
    expect(ohlcvUrl).toContain('currency=token')
  })

  it('uses 30 daily candles for the 30d window', async () => {
    const { fetchImpl, urls } = fakeFetch({
      '/tokens/multi/': { json: multiResponse({ subject: SUBJECT, pools: [ADA_POOL] }) },
      '/ohlcv/day': { json: { data: { attributes: { ohlcv_list: DAILY_CANDLES_7D } } } },
    })

    await client(undefined, fetchImpl).getTokenActivity([SUBJECT], '30d')

    expect(urls.find((u) => u.includes('/ohlcv/day'))).toContain('limit=30')
  })
})

describe('geckoterminal client — getTokenHistory', () => {
  // Newest first, as upstream returns them.
  const CANDLES = [
    [700_000_200, 0.3, 0.31, 0.29, 0.3, 500],
    [700_000_100, 0.2, 0.21, 0.19, 0.2, 500],
    [700_000_000, 0.1, 0.11, 0.09, 0.1, 500],
  ]

  it('reverses to chronological order and drops volume', async () => {
    const { fetchImpl } = fakeFetch({
      [`/tokens/${SUBJECT}/pools`]: { json: poolsResponse(ADA_POOL) },
      '/ohlcv/day': { json: { data: { attributes: { ohlcv_list: CANDLES } } } },
    })

    const candles = await client(undefined, fetchImpl).getTokenHistory(SUBJECT, '6m')

    expect(candles).toEqual([
      { time: 700_000_000, open: 0.1, high: 0.11, low: 0.09, close: 0.1 },
      { time: 700_000_100, open: 0.2, high: 0.21, low: 0.19, close: 0.2 },
      { time: 700_000_200, open: 0.3, high: 0.31, low: 0.29, close: 0.3 },
    ])
  })

  it.each([
    ['1d', 'minute', 'aggregate=15', 'limit=96'],
    ['1w', 'hour', 'aggregate=1', 'limit=168'],
    ['1m', 'hour', 'aggregate=4', 'limit=180'],
    ['1y', 'day', 'aggregate=1', 'limit=365'],
    ['all', 'day', 'aggregate=1', 'limit=1000'],
  ] as const)('maps range %s to %s/%s/%s', async (range, timeframe, aggregate, limit) => {
    const { fetchImpl, urls } = fakeFetch({
      [`/tokens/${SUBJECT}/pools`]: { json: poolsResponse(ADA_POOL) },
      [`/ohlcv/${timeframe}`]: { json: { data: { attributes: { ohlcv_list: [] } } } },
    })

    await client(undefined, fetchImpl).getTokenHistory(SUBJECT, range)

    const ohlcvUrl = urls.find((u) => u.includes('/ohlcv/'))
    expect(ohlcvUrl).toContain(`/ohlcv/${timeframe}?`)
    expect(ohlcvUrl).toContain(aggregate)
    expect(ohlcvUrl).toContain(limit)
  })
})

describe('geckoterminal client — unhappy path', () => {
  it('omits a subject GeckoTerminal has never indexed, rather than an error', async () => {
    // The multi endpoint simply omits a token it does not index; that subject has no market.
    const { fetchImpl } = fakeFetch({ '/tokens/multi/': { json: { data: [] } } })

    const activity = await client(undefined, fetchImpl).getTokenActivity([SUBJECT], '24h')

    expect(activity).toEqual([])
  })

  it('returns an empty history for a subject with no ADA market, not an error', async () => {
    const { fetchImpl } = fakeFetch({ [`/tokens/${SUBJECT}/pools`]: { status: 404 } })

    const candles = await client(undefined, fetchImpl).getTokenHistory(SUBJECT, '1m')

    expect(candles).toEqual([])
  })

  it('omits a subject whose only pools are not paired directly with ADA', async () => {
    const nonAdaPool = pool({ quoteId: 'cardano_deadbeef' })
    const { fetchImpl } = fakeFetch({
      // Indexed, but the top pool isn't ADA-quoted, so it falls back to the full list, which also
      // has no ADA pair.
      '/tokens/multi/': { json: multiResponse({ subject: SUBJECT, pools: [nonAdaPool] }) },
      [`/tokens/${SUBJECT}/pools`]: { json: poolsResponse(nonAdaPool) },
    })

    const activity = await client(undefined, fetchImpl).getTokenActivity([SUBJECT], '24h')

    expect(activity).toEqual([])
  })

  it('omits a subject whose pool has no 24h figures yet, rather than a partial guess', async () => {
    const freshPool = pool({ changeH24: null, volumeH24: null })
    const { fetchImpl } = fakeFetch({
      '/tokens/multi/': { json: multiResponse({ subject: SUBJECT, pools: [freshPool] }) },
    })

    const activity = await client(undefined, fetchImpl).getTokenActivity([SUBJECT], '24h')

    expect(activity).toEqual([])
  })

  it('omits an oversized 24h operand while retaining healthy siblings in the batch', async () => {
    const oversizedVolume = `1${'0'.repeat(309)}`
    const malformedPool = pool({ volumeH24: oversizedVolume })
    const healthyPool = pool({ baseId: `cardano_${HEALTHY_SUBJECT}` })
    const { fetchImpl } = fakeFetch({
      '/tokens/multi/': {
        json: multiResponse(
          { subject: SUBJECT, pools: [malformedPool] },
          { subject: HEALTHY_SUBJECT, pools: [healthyPool] },
        ),
      },
    })

    const activity = await client(undefined, fetchImpl).getTokenActivity(
      [SUBJECT, HEALTHY_SUBJECT],
      '24h',
    )

    expect(activity).toHaveLength(1)
    expect(activity[0]?.subject).toBe(HEALTHY_SUBJECT)
    expect(activity[0]?.volumeAda).toBe('591187.5812361061')
  })

  it('omits a pool with a non-finite 24h change while retaining healthy siblings', async () => {
    const malformedPool = pool({ changeH24: `1${'0'.repeat(309)}` })
    const healthyPool = pool({ baseId: `cardano_${HEALTHY_SUBJECT}` })
    const { fetchImpl } = fakeFetch({
      '/tokens/multi/': {
        json: multiResponse(
          { subject: SUBJECT, pools: [malformedPool] },
          { subject: HEALTHY_SUBJECT, pools: [healthyPool] },
        ),
      },
    })

    const activity = await client(undefined, fetchImpl).getTokenActivity(
      [SUBJECT, HEALTHY_SUBJECT],
      '24h',
    )

    expect(activity).toHaveLength(1)
    expect(activity[0]?.subject).toBe(HEALTHY_SUBJECT)
  })

  it('omits a subject with an ADA pool but no candles yet for the 7d/30d window', async () => {
    const { fetchImpl } = fakeFetch({
      '/tokens/multi/': { json: multiResponse({ subject: SUBJECT, pools: [ADA_POOL] }) },
      '/ohlcv/day': { json: { data: { attributes: { ohlcv_list: [] } } } },
    })

    const activity = await client(undefined, fetchImpl).getTokenActivity([SUBJECT], '7d')

    expect(activity).toEqual([])
  })

  it('propagates a genuine upstream failure rather than treating it as "no data"', async () => {
    const { fetchImpl } = fakeFetch({ '/tokens/multi/': { status: 503 } })

    await expect(client(undefined, fetchImpl).getTokenActivity([SUBJECT], '24h')).rejects.toThrow(
      ProviderError,
    )
  })

  it('maps a timeout to ProviderTimeoutError', async () => {
    const fetchImpl: FetchLike = async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }

    await expect(client(undefined, fetchImpl).getTokenActivity([SUBJECT], '24h')).rejects.toThrow(
      ProviderTimeoutError,
    )
  })

  it('maps a malformed multi-token shape to MalformedUpstreamError', async () => {
    const { fetchImpl } = fakeFetch({
      '/tokens/multi/': { json: { data: [{ attributes: { address: 1 } }] } },
    })

    await expect(client(undefined, fetchImpl).getTokenActivity([SUBJECT], '24h')).rejects.toThrow(
      MalformedUpstreamError,
    )
  })

  it('never emits a non-finite changePercent for a degenerate zero-priced candle', async () => {
    const zeroOpenCandles = [
      [700_000_100, 0.5, 0.5, 0.5, 0.5, 10],
      [700_000_000, 0, 0, 0, 0, 10], // oldest candle opened at 0
    ]
    const { fetchImpl } = fakeFetch({
      '/tokens/multi/': { json: multiResponse({ subject: SUBJECT, pools: [ADA_POOL] }) },
      '/ohlcv/day': { json: { data: { attributes: { ohlcv_list: zeroOpenCandles } } } },
    })

    const activity = await client(undefined, fetchImpl).getTokenActivity([SUBJECT], '7d')

    expect(activity).toEqual([])
  })
})

describe('geckoterminal client — pool lookup coalescing', () => {
  it('collapses two concurrent history lookups for the same subject onto one pool call', async () => {
    const { fetchImpl, urls } = fakeFetch({
      [`/tokens/${SUBJECT}/pools`]: { json: poolsResponse(ADA_POOL) },
      '/ohlcv/day': { json: { data: { attributes: { ohlcv_list: [] } } } },
    })
    const cache = createMemoryCache()
    const provider = client(cache, fetchImpl)

    // Fired together, before either resolves: without in-flight coalescing on the pool lookup they
    // would each issue the identical /tokens/{subject}/pools call and race to cache it.
    const [a, b] = await Promise.all([
      provider.getTokenHistory(SUBJECT, '6m'),
      provider.getTokenHistory(SUBJECT, '6m'),
    ])

    expect(a).toEqual(b)
    expect(urls.filter((u) => u.includes(`/tokens/${SUBJECT}/pools`))).toHaveLength(1)
  })
})

describe('geckoterminal client — batch call count', () => {
  // Timing is not what this test measures, so the bucket is a passthrough; the shared bucket's
  // pacing is covered in rate-limit.test.ts.
  const passthroughBucket: TokenBucket = { acquire: () => Promise.resolve() }

  it('resolves a cold 100-subject batch in ceil(N/30) multi calls, with a bounded fallback', async () => {
    const subjects = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(56, '0'))
    // One subject whose most-liquid pool isn't ADA-quoted, forcing a single per-token fallback.
    const nonAda = subjects[0]!

    const urls: string[] = []
    const fetchImpl: FetchLike = (async (url: string) => {
      urls.push(url)
      if (url.includes('/tokens/multi/')) {
        const addrs = url
          .slice(url.indexOf('/multi/') + '/multi/'.length, url.indexOf('?'))
          .split(',')
        const data = addrs.map((subject) => ({
          attributes: { address: subject },
          relationships: { top_pools: { data: [{ id: `pool_${subject}` }] } },
        }))
        const included = addrs.map((subject) => ({
          id: `pool_${subject}`,
          attributes: {
            address: `addr_${subject}`,
            base_token_price_native_currency: '1.5',
            quote_token_price_usd: '0.4',
            reserve_in_usd: '1000',
            price_change_percentage: { h24: '2' },
            volume_usd: { h24: '100' },
          },
          relationships: {
            base_token: { data: { id: `cardano_${subject}` } },
            quote_token: { data: { id: subject === nonAda ? 'cardano_deadbeef' : NATIVE_ID } },
          },
        }))
        return {
          ok: true,
          status: 200,
          json: async () => ({ data, included }),
          text: async () => '',
        }
      }
      // Fallback: the non-ADA subject's full pool list does contain an ADA pair.
      return {
        ok: true,
        status: 200,
        json: async () =>
          poolsResponse(pool({ baseId: `cardano_${nonAda}`, address: `addr_${nonAda}` })),
        text: async () => '',
      }
    }) as FetchLike

    const provider = createGeckoTerminalClient({
      fetchImpl,
      tokenBucket: passthroughBucket,
      cache: createMemoryCache(),
    })

    const activity = await provider.getTokenActivity(subjects, '24h')

    const multiCalls = urls.filter((u) => u.includes('/tokens/multi/'))
    const fallbackCalls = urls.filter((u) => /\/tokens\/[0-9a-f]+\/pools/.test(u))
    expect(multiCalls).toHaveLength(4) // ceil(100 / 30), not ~100
    expect(fallbackCalls).toHaveLength(1) // only the one non-ADA-top-pool subject
    expect(urls).toHaveLength(5)
    // Every subject still resolved to a price, the fallback one included.
    expect(activity).toHaveLength(100)
  })

  // A multi-token fetch that records the addresses of every call and answers each with an
  // ADA-quoted pool, so a resolved subject needs no fallback.
  function recordingMultiFetch() {
    const calls: string[][] = []
    const fetchImpl: FetchLike = (async (url: string) => {
      const addrs = url
        .slice(url.indexOf('/multi/') + '/multi/'.length, url.indexOf('?'))
        .split(',')
      calls.push(addrs)
      const data = addrs.map((subject) => ({
        attributes: { address: subject },
        relationships: { top_pools: { data: [{ id: `pool_${subject}` }] } },
      }))
      const included = addrs.map((subject) => ({
        id: `pool_${subject}`,
        attributes: {
          address: `addr_${subject}`,
          base_token_price_native_currency: '1',
          quote_token_price_usd: '0.4',
          reserve_in_usd: '10',
          price_change_percentage: { h24: '1' },
          volume_usd: { h24: '5' },
        },
        relationships: {
          base_token: { data: { id: `cardano_${subject}` } },
          quote_token: { data: { id: NATIVE_ID } },
        },
      }))
      return { ok: true, status: 200, json: async () => ({ data, included }), text: async () => '' }
    }) as FetchLike
    return { fetchImpl, calls }
  }

  it('coalesces overlapping concurrent batches so a shared subject is resolved once', async () => {
    const [s1, s2, s3, s4] = [1, 2, 3, 4].map((n) => n.toString(16).padStart(56, '0')) as [
      string,
      string,
      string,
      string,
    ]
    const { fetchImpl, calls } = recordingMultiFetch()
    const provider = createGeckoTerminalClient({
      fetchImpl,
      tokenBucket: passthroughBucket,
      cache: createMemoryCache(),
    })

    // Both launched before either awaits: the second batch sees s2/s3 already in flight from the
    // first and must not re-fetch them.
    const pA = provider.getTokenActivity([s1, s2, s3], '24h')
    const pB = provider.getTokenActivity([s2, s3, s4], '24h')
    const [a, b] = await Promise.all([pA, pB])

    // Every subject was requested from upstream exactly once: the shared s2/s3 were coalesced, not
    // duplicated across the two batches' multi-token calls.
    const requested = calls.flat()
    expect([...requested].sort()).toEqual([s1, s2, s3, s4].sort())
    expect(new Set(requested).size).toBe(requested.length)

    // Both batches still received a price for each of their subjects.
    expect(a.map((x) => x.subject).sort()).toEqual([s1, s2, s3].sort())
    expect(b.map((x) => x.subject).sort()).toEqual([s2, s3, s4].sort())
  })
})

describe('geckoterminal client — regression', () => {
  it('keeps priceAda and volumeAda as decimal strings in the 24h path', async () => {
    const { fetchImpl } = fakeFetch({
      '/tokens/multi/': { json: multiResponse({ subject: SUBJECT, pools: [ADA_POOL] }) },
    })

    const [activity] = await client(undefined, fetchImpl).getTokenActivity([SUBJECT], '24h')

    expect(typeof activity?.priceAda).toBe('string')
    expect(typeof activity?.volumeAda).toBe('string')
  })

  it('keeps priceAda and volumeAda as decimal strings in the 7d/30d path, never scientific notation', async () => {
    const tinyCandles = [
      [700_000_100, 1e-9, 1e-9, 1e-9, 1e-9, 1],
      [700_000_000, 1e-9, 1e-9, 1e-9, 1e-9, 1],
    ]
    const { fetchImpl } = fakeFetch({
      '/tokens/multi/': { json: multiResponse({ subject: SUBJECT, pools: [ADA_POOL] }) },
      '/ohlcv/day': { json: { data: { attributes: { ohlcv_list: tinyCandles } } } },
    })

    const [activity] = await client(undefined, fetchImpl).getTokenActivity([SUBJECT], '7d')

    expect(typeof activity?.priceAda).toBe('string')
    expect(activity?.priceAda).not.toMatch(/e[+-]/i)
    expect(activity?.priceAda).toBe('0.000000001')
  })

  it('keeps Ohlc.time as GeckoTerminal already gives it, unix seconds, an integer', async () => {
    const { fetchImpl } = fakeFetch({
      [`/tokens/${SUBJECT}/pools`]: { json: poolsResponse(ADA_POOL) },
      '/ohlcv/day': {
        json: { data: { attributes: { ohlcv_list: [[700_000_000, 0.1, 0.1, 0.1, 0.1, 1]] } } },
      },
    })

    const [candle] = await client(undefined, fetchImpl).getTokenHistory(SUBJECT, '6m')

    expect(candle?.time).toBe(700_000_000)
    expect(Number.isInteger(candle?.time)).toBe(true)
  })
})
