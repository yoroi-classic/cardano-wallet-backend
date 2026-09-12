import { createHash } from 'node:crypto'
import { z } from 'zod'
import { noCache, type Cache } from '../cache/index.js'
import type { Ohlc, PriceRange, PriceWindow, TokenActivity } from '../domain/types/price.js'
import { divideDecimalStrings, toDecimalString } from './decimal.js'
import { fetchJsonOrNotFound, type FetchLike } from './http.js'
import { createTokenBucket, type TokenBucket } from './rate-limit.js'

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
 * GeckoTerminal's free public API allows 30 calls per minute (per its FAQ). Two things keep us
 * inside that budget:
 *
 *  - The batch live-price path asks the multi-token endpoint for up to `MULTI_TOKEN_BATCH` tokens
 *    in one call, so a cold 100-subject request is ~4 calls, not ~100. See `getTokenActivity`.
 *  - Every call this client makes, from any concurrent request, still passes through one shared
 *    token bucket (built in the client factory) as a backstop. It lets a small burst through and
 *    then paces the rest at a sustained rate set a little under 30/min, so the busiest 60-second
 *    window stays under the real limit even when several batches or history charts overlap.
 *    Limiting concurrency alone would not do this: it caps how many calls run at once, not how
 *    many go out per minute, which is the quota GeckoTerminal actually enforces.
 *
 * Tune these if the upstream tier changes.
 */
const GECKOTERMINAL_BURST = 4
// 24 calls/min sustained. With the burst, the busiest minute holds ~28 calls, under the 30 limit.
const GECKOTERMINAL_MIN_INTERVAL_MS = 2_500

/** The multi-token endpoint accepts up to this many comma-separated addresses in one call. */
const MULTI_TOKEN_BATCH = 30

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

// The multi-token endpoint (`/tokens/multi/{addresses}?include=top_pools`) answers with each
// token's most-liquid pool inlined under `included`, keyed by a JSON:API id and referenced from the
// token's `top_pools` relationship. That top pool is whichever is most liquid overall, which need
// not be the ADA-quoted one this API requires; see `resolveAdaPoolsBatch` for the fallback.
const includedPool = poolEntry.extend({ id: z.string() })

const multiTokenEntry = z.object({
  attributes: z.object({ address: z.string() }),
  relationships: z
    .object({ top_pools: z.object({ data: z.array(z.object({ id: z.string() })) }).optional() })
    .optional(),
})

const multiTokensResponse = z.object({
  data: z.array(multiTokenEntry),
  included: z.array(includedPool).optional(),
})

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

function toAdaPool(pool: z.infer<typeof poolEntry>): AdaPool {
  return {
    address: pool.attributes.address,
    priceAda: pool.attributes.base_token_price_native_currency,
    adaUsdPrice: pool.attributes.quote_token_price_usd,
    changePercent24h: pool.attributes.price_change_percentage?.h24,
    volumeUsd24h: pool.attributes.volume_usd?.h24,
  }
}

/**
 * The most liquid ADA-quoted pool among `pools`, or undefined when none is paired directly with
 * ADA. Liquidity is compared by the pools' own reserves rather than trusting upstream ordering.
 */
function pickMostLiquidAdaPool(
  subject: string,
  pools: z.infer<typeof poolEntry>[],
): AdaPool | undefined {
  let best: z.infer<typeof poolEntry> | undefined
  let bestReserve = -1
  for (const pool of pools) {
    if (!isDirectAdaPool(subject, pool)) continue
    const reserve = Number(pool.attributes.reserve_in_usd ?? '0')
    if (best === undefined || reserve > bestReserve) {
      best = pool
      bestReserve = reserve
    }
  }
  return best === undefined ? undefined : toAdaPool(best)
}

/** Drop duplicate subjects while keeping first-seen order. Input is already lowercased. */
function dedupeSubjects(subjects: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const subject of subjects) {
    if (seen.has(subject)) continue
    seen.add(subject)
    unique.push(subject)
  }
  return unique
}

const poolCacheKey = (cacheNamespace: string, subject: string) =>
  `price:token:pool:${cacheNamespace}:${subject}`

/**
 * Stable identity for a selected pool in a cache key.
 *
 * GeckoTerminal addresses are case-insensitive Cardano identifiers, so normalize their spelling
 * before hashing. The one-way identity keeps upstream strings out of process diagnostics if cache
 * keys are ever inspected; in particular, never solve this by keying on a request URL, which can
 * grow credentials or other query parameters later.
 */
function poolCacheIdentity(address: string): string {
  return createHash('sha256').update(address.toLowerCase()).digest('hex')
}

function ohlcvCacheKey(
  cacheNamespace: string,
  subject: string,
  poolAddress: string,
  kind: 'history' | 'activity',
  range: PriceRange | PriceWindow,
): string {
  return `price:token:ohlcv:${cacheNamespace}:${subject}:pool:${poolCacheIdentity(poolAddress)}:${kind}:${range}`
}

/** Build a TokenActivity from a resolved pool's own 24h figures, or undefined when incomplete. */
function activityFromPool(subject: string, pool: AdaPool | undefined): TokenActivity | undefined {
  if (pool === undefined) return undefined
  // Both fields are genuinely optional in GeckoTerminal's schema (a pool too new to have a 24h
  // figure yet). Reporting a partial answer would mean guessing whichever is missing, so the whole
  // subject is omitted instead, exactly as an unresolved pool is.
  if (pool.changePercent24h === undefined || pool.volumeUsd24h === undefined) return undefined

  // The schema deliberately accepts arbitrarily long decimal strings because they are valid
  // upstream syntax. Number() can nevertheless overflow one of those strings, and the decimal
  // helper reports that as a RangeError. Treat that one subject as unresolved, just like a pool
  // with no 24h figures, so malformed market data cannot become a 500 or discard healthy siblings
  // in the same batch.
  let volumeAda: string
  try {
    volumeAda = divideDecimalStrings(pool.volumeUsd24h, pool.adaUsdPrice)
  } catch (error) {
    if (error instanceof RangeError) return undefined
    throw error
  }
  const changePercent = Number(pool.changePercent24h)
  if (!Number.isFinite(changePercent)) return undefined

  return {
    subject,
    priceAda: pool.priceAda,
    changePercent,
    volumeAda,
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/** A promise whose settlement is controlled from outside, for sharing one in-flight result. */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export interface GeckoTerminalConfig {
  cache?: Cache
  fetchImpl?: FetchLike
  baseUrl?: string
  timeoutMs?: number
  /** Namespace cache entries by the deployment's chain network. Defaults to the upstream network. */
  cacheNamespace?: string
  /**
   * The rate limiter every upstream call is paced through. Injectable so a test can drive it with
   * its own clock; production gets the shared default built from the constants above.
   */
  tokenBucket?: TokenBucket
}

export interface GeckoTerminalClient {
  getTokenActivity(subjects: string[], window: PriceWindow): Promise<TokenActivity[]>
  getTokenHistory(subject: string, range: PriceRange): Promise<Ohlc[]>
}

export function createGeckoTerminalClient(config: GeckoTerminalConfig = {}): GeckoTerminalClient {
  const baseUrl = (config.baseUrl ?? DEFAULT_GECKOTERMINAL_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // GeckoTerminal's API path is Cardano-wide, while deployments can be mainnet, preprod, or
  // preview. Keep those process-cache entries separate even though the upstream path is fixed.
  const cacheNamespace = config.cacheNamespace ?? NETWORK
  const rawFetch: FetchLike = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const cache = config.cache ?? noCache
  const bucket =
    config.tokenBucket ??
    createTokenBucket({
      capacity: GECKOTERMINAL_BURST,
      refillIntervalMs: GECKOTERMINAL_MIN_INTERVAL_MS,
    })

  // Per-subject in-flight pool resolutions, shared across every concurrent request to this client.
  // The batch path (`resolveAdaPoolsBatch`) registers a subject here while its multi-token lookup is
  // outstanding, so an overlapping batch that arrives meanwhile awaits the same resolution instead
  // of issuing a duplicate call. This is the batch counterpart to `cache.read`'s own coalescing,
  // which already covers the per-subject and history paths.
  const inFlightPools = new Map<string, Promise<AdaPool | undefined>>()

  // Every GeckoTerminal call, from any concurrent request, passes through the one shared bucket
  // before it goes out, so the whole client stays inside the keyless-tier rate rather than each
  // request bursting on its own.
  const fetchImpl: FetchLike = async (url, init) => {
    await bucket.acquire()
    return rawFetch(url, init)
  }

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
   *
   * Resolution runs inside `cache.read`, not a peek/fetch/set sequence, so its in-flight
   * coalescing covers this call too: two concurrent requests for the same subject (including a
   * duplicate inside one batch) collapse onto a single upstream lookup instead of racing to issue
   * identical ones. A confirmed absence is stored as `null` (which `read` caches like any other
   * value) so a subject with no market is not re-asked about on every request.
   */
  async function resolveAdaPool(subject: string): Promise<AdaPool | undefined> {
    const resolved = await cache.read<AdaPool | null>(
      poolCacheKey(cacheNamespace, subject),
      TOKEN_POOL_TTL_MS,
      async () => {
        const body = await getOrNotFound(
          `/networks/${NETWORK}/tokens/${subject}/pools`,
          tokenPoolsResponse,
        )
        return pickMostLiquidAdaPool(subject, body?.data ?? []) ?? null
      },
    )
    return resolved ?? undefined
  }

  /**
   * The upstream half of batch resolution: resolve `subjects` (all known-uncached and de-duplicated)
   * via the multi-token endpoint, up to `MULTI_TOKEN_BATCH` per call, so a cold 100-subject batch is
   * ~4 calls rather than ~100. That endpoint returns each token's single most-liquid pool: when it
   * is already ADA-quoted it is used as-is with no further call. A subject the endpoint does not
   * return at all is one GeckoTerminal does not index, so it has no market. Only a subject that *is*
   * indexed but whose most-liquid pool is not ADA-quoted falls back to the per-token pools endpoint,
   * which lists every pool so the most-liquid ADA-paired one can still be found. ADA is the dominant
   * quote asset across Cardano DEXes, so that fallback is the exception, not the rule.
   */
  async function fetchAdaPools(subjects: string[]): Promise<Map<string, AdaPool | undefined>> {
    const resolved = new Map<string, AdaPool | undefined>()
    const needsFallback: string[] = []
    for (let i = 0; i < subjects.length; i += MULTI_TOKEN_BATCH) {
      const chunk = subjects.slice(i, i + MULTI_TOKEN_BATCH)
      const body = await getOrNotFound(
        `/networks/${NETWORK}/tokens/multi/${chunk.join(',')}?include=top_pools`,
        multiTokensResponse,
      )

      const poolsById = new Map<string, z.infer<typeof includedPool>>()
      for (const pool of body?.included ?? []) poolsById.set(pool.id, pool)

      const returned = new Set<string>()
      for (const token of body?.data ?? []) {
        const subject = token.attributes.address.toLowerCase()
        returned.add(subject)
        const topPools = (token.relationships?.top_pools?.data ?? [])
          .map((ref) => poolsById.get(ref.id))
          .filter((pool): pool is z.infer<typeof includedPool> => pool !== undefined)
        const adaPool = pickMostLiquidAdaPool(subject, topPools)
        if (adaPool !== undefined) {
          cache.set(poolCacheKey(cacheNamespace, subject), adaPool, TOKEN_POOL_TTL_MS)
          resolved.set(subject, adaPool)
        } else {
          // Indexed, but its most-liquid pool is not ADA-quoted. Its full pool list may still hold
          // an ADA pair, so defer to the per-token lookup below.
          needsFallback.push(subject)
        }
      }

      // A subject the endpoint did not return is not indexed at all: no pool, no market. Cache the
      // absence so it is not re-asked about, mirroring `resolveAdaPool`'s negative cache.
      for (const subject of chunk) {
        if (!returned.has(subject)) {
          cache.set(poolCacheKey(cacheNamespace, subject), null, TOKEN_POOL_TTL_MS)
          resolved.set(subject, undefined)
        }
      }
    }

    await Promise.all(
      needsFallback.map(async (subject) => {
        resolved.set(subject, await resolveAdaPool(subject))
      }),
    )

    return resolved
  }

  /**
   * Resolve the ADA pool for many subjects in as few upstream calls as possible.
   *
   * Cache hits are served first. Of the misses, any subject already being resolved by another
   * concurrent batch is awaited rather than fetched again (`inFlightPools`); the rest are claimed by
   * this call, fetched together through `fetchAdaPools`, and their shared promises settled for the
   * waiters. Two overlapping batches therefore issue one multi-token lookup for the subjects they
   * share, not two, at subject granularity, so a partial overlap still shares its common subjects.
   */
  async function resolveAdaPoolsBatch(
    subjects: string[],
  ): Promise<Map<string, AdaPool | undefined>> {
    const resolved = new Map<string, AdaPool | undefined>()
    const awaiting = new Map<string, Promise<AdaPool | undefined>>()
    const owned = new Map<string, Deferred<AdaPool | undefined>>()

    for (const subject of subjects) {
      const cached = cache.peek<AdaPool | null>(poolCacheKey(cacheNamespace, subject))
      if (cached !== undefined) {
        resolved.set(subject, cached ?? undefined)
        continue
      }
      const pending = inFlightPools.get(subject)
      if (pending !== undefined) {
        awaiting.set(subject, pending)
        continue
      }
      // First to want this subject: register a shared promise others can await, and claim the fetch.
      const deferred = createDeferred<AdaPool | undefined>()
      inFlightPools.set(subject, deferred.promise)
      owned.set(subject, deferred)
      awaiting.set(subject, deferred.promise)
    }

    if (owned.size > 0) {
      try {
        const fetched = await fetchAdaPools([...owned.keys()])
        for (const [subject, deferred] of owned) deferred.resolve(fetched.get(subject))
      } catch (error) {
        // Fail every waiter on this attempt, exactly as `cache.read` fails its coalesced callers.
        for (const deferred of owned.values()) deferred.reject(error)
      } finally {
        for (const subject of owned.keys()) inFlightPools.delete(subject)
      }
    }

    // Await via Promise.all so every shared promise has a handler attached (no stray unhandled
    // rejection if the fetch failed); the first rejection still propagates to this caller.
    await Promise.all(
      [...awaiting].map(async ([subject, promise]) => {
        resolved.set(subject, await promise)
      }),
    )
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

  /**
   * The 7d/30d figures for one subject, derived from its pool's daily candles: the close of the
   * newest is "now", the open of the oldest is "then", and the window's volume is their sum. These
   * have no equivalent field on the pool object, so this is one OHLCV call per subject (paced by
   * the shared bucket), unlike the 24h figures which come straight off the resolved pool.
   */
  async function activityFromCandles(
    subject: string,
    pool: AdaPool | undefined,
    window: PriceWindow,
  ): Promise<TokenActivity | undefined> {
    if (pool === undefined) return undefined
    const days = window === '7d' ? 7 : 30
    const cacheKey = ohlcvCacheKey(cacheNamespace, subject, pool.address, 'activity', window)
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
      const normalized = dedupeSubjects(subjects.map((subject) => subject.toLowerCase()))

      // One batched multi-token lookup resolves every subject's ADA pool (~ceil(N/30) calls), so
      // the live-price path never fans out to one call per subject.
      const pools = await resolveAdaPoolsBatch(normalized)

      if (window === '24h') {
        // Every 24h figure is already on the pool the batch resolved: no further call per subject.
        const results: TokenActivity[] = []
        for (const subject of normalized) {
          const activity = activityFromPool(subject, pools.get(subject))
          if (activity !== undefined) results.push(activity)
        }
        return results
      }

      // 7d/30d have no field on the pool, so each is one OHLCV call, all paced by the same bucket.
      const results = await Promise.all(
        normalized.map((subject) => activityFromCandles(subject, pools.get(subject), window)),
      )

      // Unresolvable subjects (no direct ADA pool, or a pool too new for this window) are simply
      // absent from the result, mirroring how /v1/assets/info already treats a subject Koios has
      // never heard of: omission, not a zero.
      return results.filter((activity): activity is TokenActivity => activity !== undefined)
    },

    async getTokenHistory(subject: string, range: PriceRange): Promise<Ohlc[]> {
      const normalized = subject.toLowerCase()
      const pool = await resolveAdaPool(normalized)
      // No ADA market for this subject: an empty candle list, same as a real token with no trades
      // yet would produce. Never a candle at zero, and not a 404 either, since the response shape
      // for this route is otherwise a plain array either way.
      if (pool === undefined) return []

      const { timeframe, aggregate, limit } = RANGE_TO_OHLCV[range]
      const cacheKey = ohlcvCacheKey(cacheNamespace, normalized, pool.address, 'history', range)
      const candles = await cache.read(cacheKey, TOKEN_HISTORY_TTL_MS, () =>
        fetchOhlcv(pool.address, timeframe, aggregate, limit),
      )

      return candles.map(([time, open, high, low, close]) => ({ time, open, high, low, close }))
    },
  }
}
