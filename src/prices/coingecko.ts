import { z } from 'zod'
import { noCache, type Cache } from '../cache/index.js'
import type { AdaPrice, Ohlc, PriceRange } from '../domain/types/price.js'
import { fetchJson, type FetchLike } from './http.js'

/**
 * CoinGecko: ADA's fiat price and its price history.
 *
 * CoinGecko's coin-list endpoints cover the large, liquid coins well (ADA among them) but don't
 * meaningfully cover the long tail of Cardano native tokens, which is why those are priced through
 * GeckoTerminal instead (see geckoterminal.ts). This module only ever asks CoinGecko about the one
 * coin id it actually indexes well for us: `cardano`.
 *
 * ## No key required
 *
 * The public endpoints used here answer without any credential, rate-limited at CoinGecko's
 * anonymous tier. An optional `COINGECKO_API_KEY` (a free "Demo" tier key) raises that limit; it
 * is sent as the `x-cg-demo-api-key` header CoinGecko documents for that tier, never as a query
 * parameter, so it can never end up copied into a log line built from a URL.
 */

const CARDANO_COIN_ID = 'cardano'

export const DEFAULT_COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3'

const DEFAULT_TIMEOUT_MS = 10_000

/** How long a live ADA fiat quote is served before asking CoinGecko again. */
export const ADA_PRICE_TTL_MS = 60_000

/**
 * How long an ADA history candle set is served.
 *
 * Longer than the live price, because a closed candle does not change; only the most recent one
 * (still in progress) does. CoinGecko's own OHLC cache refreshes roughly every 15 minutes, so 5
 * minutes stays safely inside that while still cutting our call volume well below one per request.
 */
export const ADA_HISTORY_TTL_MS = 5 * 60_000

const RANGE_TO_DAYS: Record<PriceRange, string> = {
  '1d': '1',
  '1w': '7',
  '1m': '30',
  '6m': '180',
  '1y': '365',
  all: 'max',
}

// CoinGecko's `/simple/price` nests every requested currency, plus a `<currency>_24h_change`
// sibling for each, plus `last_updated_at`, all as sibling numeric fields under the coin id. The
// currency codes are caller-chosen and therefore dynamic, so this is validated as "every value
// under `cardano` is a number" rather than naming each key, which tolerates whichever currencies
// were actually asked for while still rejecting a genuinely malformed (non-numeric) entry.
const simplePriceSchema = z.object({
  cardano: z.record(z.string(), z.number().finite()),
})

const ohlcSchema = z.array(
  z.tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
  ]),
)

export interface CoingeckoConfig {
  /** Free "Demo" tier key. Absent works fine, just at a lower anonymous rate limit. */
  apiKey?: string
  cache?: Cache
  fetchImpl?: FetchLike
  baseUrl?: string
  timeoutMs?: number
}

export interface CoingeckoClient {
  getAdaPrice(currencies: string[]): Promise<AdaPrice>
  getAdaHistory(range: PriceRange, currency: string): Promise<Ohlc[]>
}

export function createCoingeckoClient(config: CoingeckoConfig = {}): CoingeckoClient {
  const baseUrl = (config.baseUrl ?? DEFAULT_COINGECKO_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl: FetchLike = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const cache = config.cache ?? noCache
  const headers = config.apiKey === undefined ? undefined : { 'x-cg-demo-api-key': config.apiKey }

  function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return fetchJson(`${baseUrl}${path}`, schema, {
      fetchImpl,
      timeoutMs,
      upstream: 'coingecko',
      ...(headers === undefined ? {} : { headers }),
    })
  }

  return {
    async getAdaPrice(currencies: string[]): Promise<AdaPrice> {
      const key = `price:ada:${[...currencies].sort().join(',')}`

      return cache.read(key, ADA_PRICE_TTL_MS, async () => {
        const csv = currencies.map((c) => c.toLowerCase()).join(',')
        const path =
          `/simple/price?ids=${CARDANO_COIN_ID}&vs_currencies=${encodeURIComponent(csv)}` +
          '&include_24hr_change=true&include_last_updated_at=true'
        const body = await get(path, simplePriceSchema)
        const row = body.cardano

        const prices: Record<string, number> = {}
        const changePercent24h: Record<string, number> = {}
        for (const currency of currencies) {
          const lower = currency.toLowerCase()
          const price = row[lower]
          // A currency CoinGecko does not price (a well-formed but unsupported code, e.g. an old
          // or delisted fiat) is simply absent from its response rather than an error. Omitting it
          // here too is the honest move: the alternative, a price of 0, is exactly the invented
          // number this whole surface exists to refuse.
          if (price !== undefined) prices[currency] = price
          const change = row[`${lower}_24h_change`]
          if (change !== undefined) changePercent24h[currency] = change
        }

        // `last_updated_at` is CoinGecko's own timestamp for when the quote was taken, and using
        // it (rather than our own request time) matters specifically because this response is
        // cached: every request served from cache would otherwise report itself as fresher than
        // it is. It is only absent if CoinGecko changes its response shape, in which case falling
        // back to now is a reasonable degradation of a freshness *hint*, not of the price itself.
        const lastUpdatedAt = row.last_updated_at
        const asOf =
          lastUpdatedAt !== undefined ? Math.floor(lastUpdatedAt) : Math.floor(Date.now() / 1000)

        return { prices, changePercent24h, asOf }
      })
    },

    async getAdaHistory(range: PriceRange, currency: string): Promise<Ohlc[]> {
      const key = `price:ada:history:${range}:${currency.toLowerCase()}`

      return cache.read(key, ADA_HISTORY_TTL_MS, async () => {
        const days = RANGE_TO_DAYS[range]
        const path = `/coins/${CARDANO_COIN_ID}/ohlc?vs_currency=${encodeURIComponent(
          currency.toLowerCase(),
        )}&days=${days}`
        const rows = await get(path, ohlcSchema)

        // CoinGecko returns these chronologically already (oldest first), which is also the
        // order the token-history route below produces, so a client charting either never has to
        // know which upstream answered.
        return rows.map(([timeMs, open, high, low, close]) => ({
          time: Math.floor(timeMs / 1000),
          open,
          high,
          low,
          close,
        }))
      })
    },
  }
}
