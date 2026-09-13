import { describe, expect, it } from 'vitest'
import {
  createCoingeckoClient,
  DEFAULT_COINGECKO_BASE_URL,
  type CoingeckoConfig,
} from '../../src/prices/coingecko.js'
import type { FetchLike } from '../../src/prices/http.js'
import { createMemoryCache } from '../../src/cache/index.js'
import {
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../../src/domain/errors.js'

interface Call {
  url: string
  headers?: Record<string, string>
}

/** Route a fake fetch by a substring of the path, recording every call made. */
function fakeFetch(responses: Record<string, { status?: number; json?: unknown }>): {
  fetchImpl: FetchLike
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl: FetchLike = (async (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => {
    calls.push({ url, headers: init?.headers })
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
  return { fetchImpl, calls }
}

const SIMPLE_PRICE_BODY = {
  cardano: {
    usd: 0.42,
    usd_24h_change: 1.5,
    eur: 0.39,
    eur_24h_change: 1.2,
    last_updated_at: 1_700_000_000,
  },
}

// CoinGecko's own shape: [timestampMs, open, high, low, close], chronological.
const OHLC_BODY = [
  [1_700_000_000_123, 0.4, 0.45, 0.38, 0.41],
  [1_700_003_600_000, 0.41, 0.46, 0.4, 0.44],
]

function client(overrides: CoingeckoConfig, fetchImpl: FetchLike) {
  return createCoingeckoClient({ fetchImpl, ...overrides })
}

describe('coingecko client — happy path', () => {
  it('getAdaPrice maps the requested currencies, uppercased', async () => {
    const { fetchImpl, calls } = fakeFetch({ '/simple/price': { json: SIMPLE_PRICE_BODY } })

    const price = await client({}, fetchImpl).getAdaPrice(['USD', 'EUR'])

    expect(price).toEqual({
      prices: { USD: 0.42, EUR: 0.39 },
      changePercent24h: { USD: 1.5, EUR: 1.2 },
      asOf: 1_700_000_000,
    })
    expect(calls[0]?.url).toBe(
      `${DEFAULT_COINGECKO_BASE_URL}/simple/price?ids=cardano&vs_currencies=usd%2Ceur` +
        '&include_24hr_change=true&include_last_updated_at=true',
    )
  })

  it('sends the demo API key header when one is configured, and omits it otherwise', async () => {
    const { fetchImpl, calls } = fakeFetch({ '/simple/price': { json: SIMPLE_PRICE_BODY } })

    await client({ apiKey: 'my-key' }, fetchImpl).getAdaPrice(['USD'])

    expect(calls[0]?.headers?.['x-cg-demo-api-key']).toBe('my-key')

    const { fetchImpl: fetchImpl2, calls: calls2 } = fakeFetch({
      '/simple/price': { json: SIMPLE_PRICE_BODY },
    })
    await client({}, fetchImpl2).getAdaPrice(['USD'])
    expect(calls2[0]?.headers?.['x-cg-demo-api-key']).toBeUndefined()
  })

  it('getAdaHistory maps candles to unix seconds, chronological', async () => {
    const { fetchImpl, calls } = fakeFetch({ '/coins/cardano/ohlc': { json: OHLC_BODY } })

    const candles = await client({}, fetchImpl).getAdaHistory('1w', 'USD')

    expect(candles).toEqual([
      { time: 1_700_000_000, open: 0.4, high: 0.45, low: 0.38, close: 0.41 },
      { time: 1_700_003_600, open: 0.41, high: 0.46, low: 0.4, close: 0.44 },
    ])
    expect(calls[0]?.url).toContain('days=7')
    expect(calls[0]?.url).toContain('vs_currency=usd')
  })

  it.each([
    ['1d', '1'],
    ['1w', '7'],
    ['1m', '30'],
    ['6m', '180'],
    ['1y', '365'],
    ['all', 'max'],
  ] as const)('maps range %s to days=%s', async (range, days) => {
    const { fetchImpl, calls } = fakeFetch({ '/coins/cardano/ohlc': { json: [] } })

    await client({}, fetchImpl).getAdaHistory(range, 'USD')

    expect(calls[0]?.url).toContain(`days=${days}`)
  })

  it('caches a live quote, so a second call within the TTL never re-asks upstream', async () => {
    const cache = createMemoryCache()
    const { fetchImpl, calls } = fakeFetch({ '/simple/price': { json: SIMPLE_PRICE_BODY } })
    const coingecko = client({ cache }, fetchImpl)

    await coingecko.getAdaPrice(['USD'])
    await coingecko.getAdaPrice(['USD'])

    expect(calls).toHaveLength(1)
  })
})

describe('coingecko client — unhappy path', () => {
  it('maps a timeout to ProviderTimeoutError', async () => {
    const fetchImpl: FetchLike = async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }

    await expect(client({}, fetchImpl).getAdaPrice(['USD'])).rejects.toThrow(ProviderTimeoutError)
  })

  it('maps a 5xx to ProviderError, never a price', async () => {
    const { fetchImpl } = fakeFetch({ '/simple/price': { status: 503, json: {} } })

    await expect(client({}, fetchImpl).getAdaPrice(['USD'])).rejects.toThrow(ProviderError)
  })

  it('maps a 429 to ProviderError with an explanatory message', async () => {
    const { fetchImpl } = fakeFetch({ '/simple/price': { status: 429, json: {} } })

    await expect(client({}, fetchImpl).getAdaPrice(['USD'])).rejects.toThrow(/rate limited/)
  })

  it('maps a 404 to ProviderError rather than treating it as "no data"', async () => {
    const { fetchImpl } = fakeFetch({ '/simple/price': { status: 404, json: {} } })

    await expect(client({}, fetchImpl).getAdaPrice(['USD'])).rejects.toThrow(ProviderError)
  })

  it('maps a plain transport failure (no TimeoutError) to ProviderError', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.coingecko.com')
    }

    await expect(client({}, fetchImpl).getAdaPrice(['USD'])).rejects.toThrow(ProviderError)
  })

  it("maps CoinGecko's own 400 for an unsupported currency on the history endpoint", async () => {
    const { fetchImpl } = fakeFetch({
      '/coins/cardano/ohlc': { status: 400, json: { error: 'invalid vs_currency' } },
    })

    await expect(client({}, fetchImpl).getAdaHistory('1d', 'ZZZ')).rejects.toThrow(ProviderError)
  })

  it('maps invalid json to MalformedUpstreamError', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('not json')
      },
      text: async () => 'not json',
    })

    await expect(client({}, fetchImpl).getAdaPrice(['USD'])).rejects.toThrow(MalformedUpstreamError)
  })

  it.each([
    ['non-numeric', 'not-a-number'],
    ['non-finite', Number.POSITIVE_INFINITY],
  ])('maps a malformed shape (a %s price) to MalformedUpstreamError', async (_kind, value) => {
    const { fetchImpl } = fakeFetch({
      '/simple/price': { json: { cardano: { usd: value } } },
    })

    await expect(client({}, fetchImpl).getAdaPrice(['USD'])).rejects.toThrow(MalformedUpstreamError)
  })

  it('never invents a price for a currency CoinGecko has no data for: omits it instead', async () => {
    const { fetchImpl } = fakeFetch({
      '/simple/price': { json: { cardano: { usd: 0.42, usd_24h_change: 1.5 } } },
    })

    const price = await client({}, fetchImpl).getAdaPrice(['USD', 'ZZZ'])

    expect(price.prices).toEqual({ USD: 0.42 })
    expect(price.prices).not.toHaveProperty('ZZZ')
    expect(price.changePercent24h).toEqual({ USD: 1.5 })
  })
})

describe('coingecko client — regression', () => {
  it('omits nullable price and change fields while preserving finite values', async () => {
    const { fetchImpl } = fakeFetch({
      '/simple/price': {
        json: {
          cardano: {
            usd: 0.42,
            usd_24h_change: null,
            eur: null,
            eur_24h_change: 1.2,
            last_updated_at: 1_700_000_000,
          },
        },
      },
    })

    const price = await client({}, fetchImpl).getAdaPrice(['USD', 'EUR'])

    expect(price).toEqual({
      prices: { USD: 0.42 },
      changePercent24h: { EUR: 1.2 },
      asOf: 1_700_000_000,
    })
  })

  it('falls back asOf to now when last_updated_at is absent, rather than throwing', async () => {
    const before = Math.floor(Date.now() / 1000)
    const { fetchImpl } = fakeFetch({
      '/simple/price': { json: { cardano: { usd: 0.42 } } },
    })

    const price = await client({}, fetchImpl).getAdaPrice(['USD'])

    expect(price.asOf).toBeGreaterThanOrEqual(before)
  })

  it('falls back asOf to now when last_updated_at is null, rather than throwing', async () => {
    const before = Math.floor(Date.now() / 1000)
    const { fetchImpl } = fakeFetch({
      '/simple/price': { json: { cardano: { usd: 0.42, last_updated_at: null } } },
    })

    const price = await client({}, fetchImpl).getAdaPrice(['USD'])

    expect(price).toEqual({
      prices: { USD: 0.42 },
      changePercent24h: {},
      asOf: expect.any(Number),
    })
    expect(price.asOf).toBeGreaterThanOrEqual(before)
  })

  it('AdaPrice values stay plain numbers, never strings', async () => {
    const { fetchImpl } = fakeFetch({ '/simple/price': { json: SIMPLE_PRICE_BODY } })

    const price = await client({}, fetchImpl).getAdaPrice(['USD'])

    expect(typeof price.prices.USD).toBe('number')
    expect(typeof price.changePercent24h.USD).toBe('number')
    expect(typeof price.asOf).toBe('number')
  })
})
