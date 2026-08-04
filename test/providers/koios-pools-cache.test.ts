import { describe, expect, it } from 'vitest'
import { createMemoryCache } from '../../src/cache/index.js'
import { ProviderError } from '../../src/domain/errors.js'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'

const BASE = 'https://preprod.koios.rest/api/v1'

const poolId = (n: number): string => `pool1${String(n).padStart(51, '0')}`

function poolRow(n: number, stake: string): Record<string, unknown> {
  return {
    pool_id_bech32: poolId(n),
    pool_id_hex: String(n).padStart(56, '0'),
    pool_status: 'registered',
    margin: 0.03,
    fixed_cost: '170000000',
    pledge: '1000',
    live_pledge: '1000',
    active_stake: stake,
    live_stake: stake,
    live_saturation: 42,
    live_delegators: 10,
    block_count: 5,
    meta_json: null,
  }
}

/**
 * A fake upstream that counts calls per path and can be made to fail on demand, which is how the
 * stale-on-error behaviour is exercised without waiting for Koios to actually have a bad day.
 */
function fakeKoios(opts: { epoch?: number; tipFails?: boolean } = {}) {
  const calls: string[] = []
  let failing = false
  const state = { epoch: opts.epoch ?? 300 }

  const fetchImpl: FetchLike = async (url) => {
    const path = url.replace(BASE, '').split('?')[0] ?? ''
    calls.push(path)

    // The tip keeps working even while the pool endpoints fail, which is the realistic shape of a
    // Koios wobble: it is one slow instance, not a dead service.
    if (path === '/tip') {
      if (opts.tipFails === true) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'no tip' }
      }
      return {
        ok: true,
        status: 200,
        json: async () => [
          { hash: 'aa', epoch_no: state.epoch, abs_slot: 1, block_no: 1, block_time: 1 },
        ],
        text: async () => '',
      }
    }

    if (failing) {
      return { ok: false, status: 503, json: async () => ({}), text: async () => 'upstream is sad' }
    }

    const rows =
      path === '/pool_list'
        ? [
            { pool_id_bech32: poolId(1), active_stake: '3000' },
            { pool_id_bech32: poolId(2), active_stake: '2000' },
          ]
        : [poolRow(1, '3000'), poolRow(2, '2000')]

    return { ok: true, status: 200, json: async () => rows, text: async () => '' }
  }

  return {
    fetchImpl,
    calls,
    state,
    countOf: (path: string) => calls.filter((c) => c === path).length,
    breakUpstream: () => {
      failing = true
    },
    fixUpstream: () => {
      failing = false
    },
  }
}

const provider = (koios: ReturnType<typeof fakeKoios>, cache = createMemoryCache()) =>
  createKoiosProvider({ baseUrl: BASE, fetchImpl: koios.fetchImpl, cache, readAttempts: 1 })

describe('the pool list is cached', () => {
  it('serves a repeated page without going upstream again', async () => {
    const koios = fakeKoios()
    const p = provider(koios)

    await p.getPoolList({ limit: 50, offset: 0 })
    await p.getPoolList({ limit: 50, offset: 0 })
    await p.getPoolList({ limit: 50, offset: 0 })

    // The expensive call, made once. /pool_info is the endpoint that takes 7 to 50 seconds on
    // mainnet, so paying for it once per ninety seconds rather than once per request is the whole
    // point of this.
    expect(koios.countOf('/pool_info')).toBe(1)
    expect(koios.countOf('/pool_list')).toBe(1)
  })

  it('scans the registered set once, however many pages are asked for', async () => {
    const koios = fakeKoios()
    const p = provider(koios)

    await p.getPoolList({ limit: 1, offset: 0 })
    await p.getPoolList({ limit: 1, offset: 1 })

    // Two different pages, but the ranking underneath them is the same epoch snapshot, so the
    // full-set scan happens once. This is the thing a decorator caching by (limit, offset) could
    // not do: it would cache each page and rescan for every cold one.
    expect(koios.countOf('/pool_list')).toBe(1)
  })

  // The ranking is keyed on the epoch, not on a clock, because active_stake *is* an epoch
  // snapshot. It is fixed for five days and then moves all at once, and a duration would be wrong
  // in both directions.
  it('rescans when the epoch turns over, and not before', async () => {
    const koios = fakeKoios({ epoch: 300 })
    const cache = createMemoryCache()
    const p = provider(koios, cache)

    await p.getPoolList({ limit: 50, offset: 0 })
    expect(koios.countOf('/pool_list')).toBe(1)

    // A new epoch. The cached tip has to age out before anyone notices, so clear it as the TTL
    // would; what is under test is the ranking key, not the tip TTL.
    koios.state.epoch = 301
    cache.clear()

    await p.getPoolList({ limit: 50, offset: 0 })
    expect(koios.countOf('/pool_list')).toBe(2)
  })

  it('does not cache a ticker search', async () => {
    const koios = fakeKoios()
    const p = provider(koios)

    await p.getPoolList({ limit: 50, offset: 0, ticker: 'ADA' })
    await p.getPoolList({ limit: 50, offset: 0, ticker: 'ADA' })

    // The page cache still applies (same key), so /pool_info is spared...
    expect(koios.countOf('/pool_info')).toBe(1)
    // ...but the *ranking* is not cached for a search: each distinct search term is a different
    // upstream scan and a different key, and caching an unbounded space of user-supplied strings
    // is how a cache becomes a memory leak.
    expect(koios.countOf('/pool_list')).toBe(1)
  })
})

describe('the pool list survives an upstream wobble', () => {
  // The reason all of this exists. Measured on live mainnet, a quarter of GET /v1/pools requests
  // fail outright today, because Koios /pool_info is bimodal: ~7s on a good instance, 20-50s on a
  // bad one, against our timeout. A saturation figure two minutes old beats an error page.
  it('serves the last good page rather than failing', async () => {
    let t = 1_000
    const koios = fakeKoios()
    const p = provider(koios, createMemoryCache({ now: () => t }))

    const good = await p.getPoolList({ limit: 50, offset: 0 })
    expect(good).toHaveLength(2)

    // Two minutes later: past the 90s page TTL, so a refresh is attempted, and well inside the
    // ten-minute stale window. Upstream is now failing.
    t += 120_000
    koios.breakUpstream()

    const served = await p.getPoolList({ limit: 50, offset: 0 })

    // The user sees pools, with a saturation figure two minutes old, instead of an error page.
    expect(served).toEqual(good)
    // And the refresh really was attempted: this is stale-on-*error*, not a longer TTL.
    expect(koios.countOf('/pool_info')).toBeGreaterThan(1)
  })

  it('gives up once the stale window has passed, rather than serving last week', async () => {
    let t = 1_000
    const koios = fakeKoios()
    const cache = createMemoryCache({ now: () => t })
    const p = provider(koios, cache)

    await p.getPoolList({ limit: 50, offset: 0 })

    // Long past the stale window. An outage must eventually surface as an outage: data this old
    // is not "slightly stale", it is wrong, and a wallet showing it would be lying.
    t += 60 * 60_000
    koios.breakUpstream()

    await expect(p.getPoolList({ limit: 50, offset: 0 })).rejects.toBeInstanceOf(ProviderError)
  })

  it('fails outright when there is nothing cached to fall back to', async () => {
    const koios = fakeKoios()
    const p = provider(koios)
    koios.breakUpstream()

    // A cold cache and a broken upstream is a genuine failure, and must look like one. Serving an
    // empty pool list here would be far worse than an error: it reads as "there are no pools".
    await expect(p.getPoolList({ limit: 50, offset: 0 })).rejects.toBeInstanceOf(ProviderError)
  })

  // The epoch is a cache *key*, and nothing more. Letting a failure to read it become a failure to
  // serve would trade a working endpoint for a cache, which is a strictly worse service.
  it('serves the pool list uncached when the tip read fails', async () => {
    const koios = fakeKoios({ tipFails: true })
    const cache = createMemoryCache()
    const p = provider(koios, cache)

    await expect(p.getPoolList({ limit: 50, offset: 0 })).resolves.toHaveLength(2)
    await expect(p.getPoolList({ limit: 50, offset: 0 })).resolves.toHaveLength(2)

    expect(koios.countOf('/pool_list')).toBe(2)
    expect(koios.countOf('/pool_info')).toBe(2)
    expect(cache.size).toBe(0)
  })

  it('coalesces concurrent uncached requests, then refreshes a later request', async () => {
    const koios = fakeKoios({ tipFails: true })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let firstPoolInfo = true
    const fetchImpl: FetchLike = async (url) => {
      if (url.replace(BASE, '').split('?')[0] === '/pool_info' && firstPoolInfo) {
        firstPoolInfo = false
        await gate
      }
      return koios.fetchImpl(url)
    }
    const p = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    const first = p.getPoolList({ limit: 50, offset: 0 })
    const second = p.getPoolList({ limit: 50, offset: 0 })
    await Promise.resolve()
    expect(koios.countOf('/pool_info')).toBe(0)
    release()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(koios.countOf('/pool_info')).toBe(1)

    await p.getPoolList({ limit: 50, offset: 0 })
    expect(koios.countOf('/pool_info')).toBe(2)
  })

  it('does not serve an unkeyed stale page after the tip read fails', async () => {
    const koios = fakeKoios({ tipFails: true })
    const p = provider(koios)

    const good = await p.getPoolList({ limit: 50, offset: 0 })
    expect(good).toHaveLength(2)

    koios.breakUpstream()

    await expect(p.getPoolList({ limit: 50, offset: 0 })).rejects.toBeInstanceOf(ProviderError)
    expect(koios.countOf('/pool_list')).toBe(2)
  })
})
