import { describe, expect, it } from 'vitest'
import type { Cache } from '../../src/cache/index.js'
import { createPriceProvider } from '../../src/prices/index.js'
import type { FetchLike } from '../../src/prices/http.js'

function fetchReturning(json: unknown): FetchLike {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
  })) as FetchLike
}

function recordingCache(): { cache: Cache; keys: string[] } {
  const values = new Map<string, unknown>()
  const keys: string[] = []
  const cache: Cache = {
    read: <T>(_key: string, _policy: number | { ttlMs: number }, load: () => Promise<T>) => load(),
    peek: <T>(key: string) => values.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      keys.push(key)
      values.set(key, value)
    },
    get size() {
      return values.size
    },
    clear: () => values.clear(),
  }
  return { cache, keys }
}

describe('createPriceProvider', () => {
  it('routes ADA reads to the CoinGecko client', async () => {
    const provider = createPriceProvider({
      coingeckoFetchImpl: fetchReturning({
        cardano: { usd: 0.42, usd_24h_change: 1.1, last_updated_at: 1_700_000_000 },
      }),
    })

    const price = await provider.getAdaPrice(['USD'])

    expect(price).toEqual({
      prices: { USD: 0.42 },
      changePercent24h: { USD: 1.1 },
      asOf: 1_700_000_000,
    })
  })

  it('routes ADA history reads to the CoinGecko client', async () => {
    const provider = createPriceProvider({
      coingeckoFetchImpl: fetchReturning([[1_700_000_000_000, 0.4, 0.45, 0.38, 0.41]]),
    })

    const candles = await provider.getAdaHistory('1w', 'USD')

    expect(candles).toEqual([
      { time: 1_700_000_000, open: 0.4, high: 0.45, low: 0.38, close: 0.41 },
    ])
  })

  it('routes token activity reads to the GeckoTerminal client', async () => {
    const { cache, keys } = recordingCache()
    const provider = createPriceProvider({
      cache,
      cacheNamespace: 'preview',
      geckoTerminalFetchImpl: fetchReturning({ data: [] }),
    })

    // No ADA pool in an empty pools response, so this comes back empty rather than an error:
    // enough to prove the call reached the GeckoTerminal client, not CoinGecko's.
    await expect(provider.getTokenActivity(['aa'.repeat(28)], '24h')).resolves.toEqual([])
    expect(keys).toContain('price:token:pool:preview:' + 'aa'.repeat(28))
  })

  it('routes token history reads to the GeckoTerminal client', async () => {
    const provider = createPriceProvider({
      geckoTerminalFetchImpl: fetchReturning({ data: [] }),
    })

    await expect(provider.getTokenHistory('aa'.repeat(28), '1m')).resolves.toEqual([])
  })
})
