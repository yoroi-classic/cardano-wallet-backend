import { z } from 'zod'
import { noCache, type Cache } from '../cache/index.js'
import type { Ohlc, PriceRange, PriceWindow, TokenActivity } from '../domain/types/price.js'
import { divideDecimalStrings, toDecimalString } from './decimal.js'
import { fetchJsonOrNotFound, type FetchLike } from './http.js'

/**
 * GeckoTerminal: native-token price and history, in ADA.
 *
 * CoinGecko's own coin-list endpoints (coingecko.ts) cover ADA well but don't meaningfully cover
 * the long tail of Cardano native tokens; GeckoTerminal indexes DEX pools directly instead, which
 * is where that liquidity actually shows up. It is a CoinGecko product, also public and keyless.
 *
 * ## The token "address" is the subject we already use
 *
 * GeckoTerminal has no concept of a Cardano contract address, so it identifies a Cardano token by
 * `policyId + assetNameHex` concatenated with no separator — which is exactly this API's `subject`
 * key (see domain/types/price.ts and /v1/assets/info). No translation is needed in either
 * direction. ADA itself, the network's native currency, is addressed as the literal string `0x`.
 *
 * ## Why every price here comes from a pool paired directly with ADA
 *
 * A pool reports its base token's price in the chain's native currency regardless of what its
 * quote token actually is (GeckoTerminal computes that cross-rate itself). It would be tempting to
 * use the token's single most-liquid pool no matter what it is quoted against. This deliberately
 * does not: the OHLCV endpoint has no "native currency" option, only `usd` or `token` (the pool's
 * own quote token), so historical candles are only genuinely ADA-denominated when the pool's quote
 * token *is* ADA. Requiring that pairing for both the live price and the history keeps both
 * numbers sourced from the same market rather than mixing a cross-rate for one and a direct quote
 * for the other. In practice this costs us nothing: ADA is the overwhelmingly common quote asset
 * across Cardano DEXes (Minswap, SundaeSwap, WingRiders...), so a token with real liquidity almost
 * always has one. A token that genuinely has none is reported as unavailable rather than guessed
 * at via a stablecoin pool and a separate fiat conversion.
 */

const NETWORK = 'cardano'

/** GeckoTerminal's id for the network's native currency (ADA, on the `cardano` network). */
const NATIVE_TOKEN_ID = `${NETWORK}_0x`

export const DEFAULT_GECKOTERMINAL_BASE_URL = 'https://api.geckoterminal.com/api/v2'

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * How long a token's resolved ADA pool, and the live 24h figures that come with it, are served.
 *
 * This doubles as the negative cache for a token GeckoTerminal has no ADA pool for: that answer is
 * cached too (as `null`), so a popular subject that genuinely has no market doesn't get re-asked
 * about on every request either. See `resolveAdaPool`.
 */
export const TOKEN_POOL_TTL_MS = 60_000

/**
 * How long a computed OHLCV window is served: the 7d/30d activity figures, and a history chart.
 *
 * Longer than the pool TTL above, for the same reason coingecko.ts's history TTL is longer than
 * its live price: only the most recent (still-open) candle in the set is actually moving.
 */
export const TOKEN_HISTORY_TTL_MS = 5 * 60_000

/**
 * Batch fan-out for `/v1/price/tokens` (up to 100 subjects) is bounded, not run fully in parallel.
 * GeckoTerminal's free, keyless tier is a shared, low, per-IP rate limit, and this API's own
 * anonymous rate limit (120/min by default) is meant to protect exactly this kind of burst; a
 * single request for a full batch should not by itself exhaust either.
 */
const ACTIVITY_CONCURRENCY = 8

// A GeckoTerminal numeric field (a price, a volume, a percentage) serialized as a decimal string.
// Regex-validated so a malformed value fails at the parse boundary (MalformedUpstreamError)
// rather than becoming `NaN` silently the first time something downstream calls `Number()` on it.
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/)

const poolAttributes = z.object({
  address: z.string(),
  base_token_price_native_currency: decimalString,
  quote_token_price_usd: decimalString,
  reserve_in_usd: decimalString.nullish(),
  // Both the sub-key (a pool too new to have a 24h figure yet) and the whole wrapper object are
  // treated as optional: nothing in GeckoTerminal's own docs guarantees the wrapper is always
  // present, and either absence means the same thing to us, "no 24h figure for this pool".
  price_change_percentage: z.object({ h24: decimalString }).partial().optional(),
  volume_usd: z.object({ h24: decimalString }).partial().optional(),
})

const poolRelationships = z.object({
  base_token: z.object({ data: z.object({ id: z.string() }) }),
  quote_token: z.object({ data: z.object({ id: z.string() }) }),
})

const poolEntry = z.object({ attributes: poolAttributes, relationships: poolRelationships })

const tokenPoolsResponse = z.object({ data: z.array(poolEntry) })

// [unix seconds, open, high, low, close, volume]. GeckoTerminal serializes these as JSON numbers
// (unlike the pool attributes above, which are decimal strings) so there is no precision to lose
// by validating them as such; `.finite()` still guards against a NaN/Infinity sneaking through.
const ohlcvCandle = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
])
type OhlcvCandle = z.infer<typeof ohlcvCandle>

const ohlcvResponse = z.object({
  data: z.object({ attributes: z.object({ ohlcv_list: z.array(ohlcvCandle) }) }),
})

type Timeframe = 'minute' | 'hour' | 'day'

/** How a chart range maps onto GeckoTerminal's `timeframe`/`aggregate`/`limit` parameters. */
const RANGE_TO_OHLCV: Record<
  PriceRange,
  { timeframe: Timeframe; aggregate: number; limit: number }
> = {
  '1d': { timeframe: 'minute', aggregate: 15, limit: 96 }, // 96 * 15m = 24h
  '1w': { timeframe: 'hour', aggregate: 1, limit: 168 }, // 168h = 7d
  '1m': { timeframe: 'hour', aggregate: 4, limit: 180 }, // 180 * 4h = 30d
  '6m': { timeframe: 'day', aggregate: 1, limit: 180 },
  '1y': { timeframe: 'day', aggregate: 1, limit: 365 },
  // GeckoTerminal only indexes a pool from its creation, so this asks for generously more than any
  // pool could have and returns whatever actually exists rather than a fixed window. See
  // fetchOhlcv: an empty or short result is real history, never padded.
  all: { timeframe: 'day', aggregate: 1, limit: 1000 },
}

/** The token's own ADA-denominated market, resolved once per subject and cached. */
interface AdaPool {
  /** The pool's own address, used to ask for its OHLCV. */
  address: string
  /** The subject's price in ADA right now, as GeckoTerminal's own decimal string, untouched. */
  priceAda: string
  /** ADA's own USD price in this same snapshot, for converting a USD volume figure to ADA. */
  adaUsdPrice: string
  changePercent24h?: string
  volumeUsd24h?: string
}

function isDirectAdaPool(subject: string, pool: z.infer<typeof poolEntry>): boolean {
  return (
    pool.relationships.base_token.data.id === `${NETWORK}_${subject}` &&
    pool.relationships.quote_token.data.id === NATIVE_TOKEN_ID
  )
}

export interface GeckoTerminalConfig {
  cache?: Cache
  fetchImpl?: FetchLike
  baseUrl?: string
  timeoutMs?: number
}

export interface GeckoTerminalClient {
  getTokenActivity(subjects: string[], window: PriceWindow): Promise<TokenActivity[]>
  getTokenHistory(subject: string, range: PriceRange): Promise<Ohlc[]>
}

export function createGeckoTerminalClient(config: GeckoTerminalConfig = {}): GeckoTerminalClient {
  const baseUrl = (config.baseUrl ?? DEFAULT_GECKOTERMINAL_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl: FetchLike = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const cache = config.cache ?? noCache

  function getOrNotFound<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    return fetchJsonOrNotFound(`${baseUrl}${path}`, schema, {
      fetchImpl,
      timeoutMs,
      upstream: 'geckoterminal',
    })
  }

  /**
   * The token's most liquid pool paired directly with ADA, or undefined when it has none.
   *
   * Cached per subject rather than per batch (mirroring koios/assets.ts's token-metadata cache),
   * so a batch of overlapping subjects across two calls to `/v1/price/tokens` shares hits, and so
   * a "no ADA pool" answer is remembered too instead of asking again on every request.
   */
  async function resolveAdaPool(subject: string): Promise<AdaPool | undefined> {
    const key = `price:token:pool:${subject}`
    const cached = cache.peek<AdaPool | null>(key)
    if (cached !== undefined) return cached ?? undefined

    const body = await getOrNotFound(
      `/networks/${NETWORK}/tokens/${subject}/pools`,
      tokenPoolsResponse,
    )
    const candidates = (body?.data ?? []).filter((pool) => isDirectAdaPool(subject, pool))

    // The most liquid candidate, picked explicitly by its own reserves rather than trusting
    // upstream to have returned them pre-sorted.
    let best: z.infer<typeof poolEntry> | undefined
    let bestReserve = -1
    for (const pool of candidates) {
      const reserve = Number(pool.attributes.reserve_in_usd ?? '0')
      if (best === undefined || reserve > bestReserve) {
        best = pool
        bestReserve = reserve
      }
    }

    const resolved: AdaPool | undefined =
      best === undefined
        ? undefined
        : {
            address: best.attributes.address,
            priceAda: best.attributes.base_token_price_native_currency,
            adaUsdPrice: best.attributes.quote_token_price_usd,
            changePercent24h: best.attributes.price_change_percentage?.h24,
            volumeUsd24h: best.attributes.volume_usd?.h24,
          }

    // A confirmed absence is stored as `null`: `peek` distinguishes "not cached" (undefined) from
    // "cached, and the answer is no" (null), and only the former is worth another upstream call.
    cache.set(key, resolved ?? null, TOKEN_POOL_TTL_MS)
    return resolved
  }

  /** OHLCV candles for one pool, chronological (oldest first), never padded to a fixed length. */
  async function fetchOhlcv(
    poolAddress: string,
    timeframe: Timeframe,
    aggregate: number,
    limit: number,
  ): Promise<OhlcvCandle[]> {
    const path =
      `/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}` +
      `?aggregate=${aggregate}&limit=${limit}&currency=token`
    const body = await getOrNotFound(path, ohlcvResponse)
    const list = body?.data.attributes.ohlcv_list ?? []
    // GeckoTerminal returns newest first; reversed once, here, so every caller (and CoinGecko's
    // own ADA history, which is already chronological) agrees on the same candle order.
    return [...list].reverse()
  }

  async function computeActivity(
    subject: string,
    window: PriceWindow,
  ): Promise<TokenActivity | undefined> {
    const pool = await resolveAdaPool(subject)
    if (pool === undefined) return undefined

    if (window === '24h') {
      // Both fields are genuinely optional in GeckoTerminal's own schema (a pool too new to have a
      // 24h figure yet). Reporting a partial answer would mean guessing at whichever is missing,
      // so the whole subject is omitted instead, exactly as an unresolved pool is above.
      if (pool.changePercent24h === undefined || pool.volumeUsd24h === undefined) return undefined
      return {
        subject,
        priceAda: pool.priceAda,
        changePercent: Number(pool.changePercent24h),
        volumeAda: divideDecimalStrings(pool.volumeUsd24h, pool.adaUsdPrice),
      }
    }

    // 7d and 30d have no equivalent field on the pool object at all, so they are derived from
    // daily candles on the same pool: the close of the newest one is "now", the open of the
    // oldest is "then", and the window's volume is their sum.
    const days = window === '7d' ? 7 : 30
    const cacheKey = `price:token:ohlcv:${subject}:activity:${window}`
    const candles = await cache.read(cacheKey, TOKEN_HISTORY_TTL_MS, () =>
      fetchOhlcv(pool.address, 'day', 1, days),
    )
    if (candles.length === 0) return undefined

    const oldest = candles[0]
    const newest = candles[candles.length - 1]
    if (oldest === undefined || newest === undefined) return undefined

    const [, oldestOpen] = oldest
    const [, , , , newestClose] = newest
    const changePercent = ((newestClose - oldestOpen) / oldestOpen) * 100
    // A pool whose oldest candle opened at 0 (degenerate, brand new) would divide to Infinity;
    // that must never reach a client as a JSON `null` (JSON.stringify(Infinity) is `null`) posing
    // as "no change".
    if (!Number.isFinite(changePercent)) return undefined

    const volumeAda = candles.reduce((sum, candle) => sum + candle[5], 0)

    return {
      subject,
      priceAda: toDecimalString(newestClose),
      changePercent,
      volumeAda: toDecimalString(volumeAda),
    }
  }

  return {
    async getTokenActivity(subjects: string[], window: PriceWindow): Promise<TokenActivity[]> {
      const normalized = subjects.map((subject) => subject.toLowerCase())
      const results: TokenActivity[] = []

      for (let i = 0; i < normalized.length; i += ACTIVITY_CONCURRENCY) {
        const chunk = normalized.slice(i, i + ACTIVITY_CONCURRENCY)
        const chunkResults = await Promise.all(
          chunk.map((subject) => computeActivity(subject, window)),
        )
        for (const activity of chunkResults) {
          // Unresolvable subjects (no direct ADA pool, or a pool too new for this window) are
          // simply absent from the result, mirroring how /v1/assets/info already treats a subject
          // Koios has never heard of: omission, not a zero.
          if (activity !== undefined) results.push(activity)
        }
      }

      return results
    },

    async getTokenHistory(subject: string, range: PriceRange): Promise<Ohlc[]> {
      const normalized = subject.toLowerCase()
      const pool = await resolveAdaPool(normalized)
      // No ADA market for this subject: an empty candle list, same as a real token with no trades
      // yet would produce. Never a candle at zero, and not a 404 either, since the response shape
      // for this route is otherwise a plain array either way.
      if (pool === undefined) return []

      const { timeframe, aggregate, limit } = RANGE_TO_OHLCV[range]
      const cacheKey = `price:token:ohlcv:${normalized}:history:${range}`
      const candles = await cache.read(cacheKey, TOKEN_HISTORY_TTL_MS, () =>
        fetchOhlcv(pool.address, timeframe, aggregate, limit),
      )

      return candles.map(([time, open, high, low, close]) => ({ time, open, high, low, close }))
    },
  }
}
