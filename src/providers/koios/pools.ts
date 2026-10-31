import { z } from 'zod'
import { ProviderError } from '../../domain/errors.js'
import type { PoolInfo, PoolListParams, PoolMetadata } from '../../domain/types/pools.js'
import type { PoolCapability } from '../capabilities/pools.js'
import type { KoiosClient } from './client.js'
import { noCache, type Cache } from '../../cache/index.js'
import { numeric } from './schema.js'

// Koios caps a single response at 1000 rows.
const POOL_LIST_PAGE_SIZE = 1000
// ~3k registered pools on mainnet today. 20 pages is far above that and keeps the walk
// bounded if upstream ever stops shrinking the last page.
const POOL_LIST_MAX_PAGES = 20

// A null active_stake is normalized to 0 here for exactly the reason mapPoolInfo normalizes it
// to '0' on the way out: if the two disagreed, a pool with no stake and a pool with zero stake
// would rank in an order the exposed values cannot explain, and the documented pool-id
// tie-break between them would not hold.
const NO_ACTIVE_STAKE = 0n

// The pool id is doing two jobs here: it is the keyset cursor the walk pages on, and the key
// the hydration joins on. A malformed one is not cosmetic, it silently ends the scan early or
// drops the pool from its page, so it is held to a shape.
//
// A shape, not a full bech32 decode. This is upstream data being used as an opaque cursor and
// join key, so what matters is that it is a well-formed, comparable pool id and not an empty
// string or a fragment of an error message. Caller-supplied ids are a different matter and are
// decoded properly at the HTTP boundary, checksum and all.
const poolIdBech32 = z.string().regex(/^pool1[0-9a-z]+$/)

const poolMetaJson = z.object({
  name: z.string().nullish(),
  ticker: z.string().nullish(),
  homepage: z.string().nullish(),
  description: z.string().nullish(),
})

// Counts are whole and non-negative; a fractional delegator or a negative block count is
// upstream junk, and bounding it here routes it to MalformedUpstreamError instead of
// letting it out through PoolInfo.
const count = z.number().int().nonnegative()

const poolInfoRow = z.object({
  pool_id_bech32: poolIdBech32,
  pool_id_hex: z.string().regex(/^[0-9a-fA-F]{56}$/),
  // Koios documents exactly these three; anything else is unexpected upstream data.
  pool_status: z.enum(['registered', 'retiring', 'retired']),
  retiring_epoch: count.nullish(),
  // An operator margin is a fraction of rewards, so it lives in [0, 1] by definition.
  margin: z.number().min(0).max(1),
  fixed_cost: numeric.nullish(),
  pledge: numeric.nullish(),
  live_pledge: numeric.nullish(),
  active_stake: numeric.nullish(),
  live_stake: numeric.nullish(),
  // Koios reports saturation as a percentage (e.g. 3.12 == 3.12%); normalize to a fraction.
  live_saturation: z.number().nonnegative().nullish(),
  live_delegators: count.nullish(),
  block_count: count.nullish(),
  meta_json: poolMetaJson.nullish(),
})

const poolStakeRow = z.object({
  pool_id_bech32: poolIdBech32,
  active_stake: numeric.nullish(),
})

type PoolStakeRow = z.infer<typeof poolStakeRow>

function activeStakeOf(row: PoolStakeRow): bigint {
  return row.active_stake == null ? NO_ACTIVE_STAKE : BigInt(row.active_stake)
}

// Largest active stake first. Ties break on pool id so that the order is total and paging
// stays stable: without it, equally-staked pools could shuffle between calls and the same
// pool could be served twice, or skipped, across two pages.
function byActiveStakeDesc(a: PoolStakeRow, b: PoolStakeRow): number {
  const left = activeStakeOf(a)
  const right = activeStakeOf(b)
  if (left !== right) return left > right ? -1 : 1
  return a.pool_id_bech32 < b.pool_id_bech32 ? -1 : a.pool_id_bech32 > b.pool_id_bech32 ? 1 : 0
}

function mapPoolMetadata(
  m: z.infer<typeof poolMetaJson> | null | undefined,
): PoolMetadata | undefined {
  if (!m) return undefined
  const md: PoolMetadata = {}
  if (m.name != null) md.name = m.name
  if (m.ticker != null) md.ticker = m.ticker
  if (m.homepage != null) md.homepage = m.homepage
  if (m.description != null) md.description = m.description
  return Object.keys(md).length > 0 ? md : undefined
}

function mapPoolInfo(row: z.infer<typeof poolInfoRow>): PoolInfo {
  return {
    poolId: row.pool_id_bech32,
    poolIdHex: row.pool_id_hex,
    status: row.pool_status,
    retiringEpoch: row.retiring_epoch ?? undefined,
    margin: row.margin,
    fixedCost: String(row.fixed_cost ?? 0),
    pledge: String(row.pledge ?? 0),
    livePledge: String(row.live_pledge ?? 0),
    activeStake: String(row.active_stake ?? 0),
    liveStake: String(row.live_stake ?? 0),
    // Koios gives saturation as a percentage; expose it as a fraction (1.0 == saturated).
    saturation: (row.live_saturation ?? 0) / 100,
    liveDelegators: row.live_delegators ?? 0,
    blocksMinted: row.block_count ?? 0,
    metadata: mapPoolMetadata(row.meta_json),
  }
}

/**
 * The ranking is the epoch snapshot the pools are ordered by, so it is keyed on the epoch and not
 * on a clock. The TTL is only a memory bound: it has to outlive an epoch (five days) so the entry
 * survives exactly as long as its key is current, and no longer.
 */
const RANKING_TTL_MS = 6 * 24 * 60 * 60 * 1000

/**
 * A served page, cached briefly.
 *
 * This is the part that is *not* epoch-fixed. A hydrated pool row carries `liveStake`,
 * `saturation` and `liveDelegators`, which drift continuously as people delegate, and they are
 * precisely the numbers someone reads while choosing a pool. Caching them for five days would
 * quietly show stale saturation, which is worse than useless on that screen.
 *
 * Ninety seconds is the compromise, and it is a big one in practice: hydrating a page costs a
 * `/pool_info` call that on mainnet takes about 7 seconds when it is fast and 20 to 50 when it is
 * not, so almost every request currently pays that. Ninety seconds of drift on a saturation
 * figure is not perceptible; twenty seconds of waiting very much is.
 */
const PAGE_TTL_MS = 90_000

/**
 * How long a page may still be served after a refresh has *failed*.
 *
 * The reason this exists at all: Koios `/pool_info` on mainnet is bimodal, answering in about 7
 * seconds most of the time and in 20 to 50 seconds the rest of the time, and measured against the
 * live service a quarter of `GET /v1/pools` requests fail outright today. Handing someone a
 * saturation figure that is two minutes old, rather than an error page, is not a close call.
 *
 * It is emphatically not a longer TTL: within the TTL we do not ask upstream, past it we do, and
 * this only decides what happens when that ask *fails*. Nor does a failure extend it, so a real
 * outage still surfaces as an error rather than as data from last week.
 */
const PAGE_STALE_IF_ERROR_MS = 10 * 60_000

export interface PoolMethodDeps {
  /** Cache for the ranking and for served pages. Defaults to none. */
  cache?: Cache
  /**
   * The current epoch, from the same cached tip the rest of the service uses. The ranking is keyed
   * on it, so it must be the epoch everyone else believes in.
   */
  currentEpoch?: () => Promise<number>
}

export function createPoolMethods(koios: KoiosClient, deps: PoolMethodDeps = {}): PoolCapability {
  const cache = deps.cache ?? noCache
  const uncachedInFlight = new Map<string, Promise<PoolInfo[]>>()

  /**
   * The epoch to key the cache on, or `undefined` if we could not find out.
   *
   * The epoch is a **cache key and nothing else**, so a failure to read it must not become a
   * failure to serve the pool list. Letting the tip read throw here would take an endpoint that
   * works and make it depend on a second one that might not, which is a strictly worse service in
   * exchange for a cache. So a failed tip read means "serve it uncached", not "return a 502".
   */
  async function cacheEpoch(): Promise<number | undefined> {
    if (deps.currentEpoch === undefined) return undefined
    try {
      return await deps.currentEpoch()
    } catch {
      return undefined
    }
  }
  // Hydrate a set of pool ids with full pool_info, preserving the input order. Unknown ids
  // are simply absent from Koios, so the result is never longer than the input.
  //
  // batchAll packs the ids into as few requests as Koios's body limit allows. It used to be a
  // fixed 50 per request, a number reached by bisecting against a 413 until it stopped
  // happening. A pool id is fixed length, so the real answer is exactly computable: 84 fit,
  // once the safety margin is held back. We were sending 1.7x more requests than the data
  // needed, every time.
  async function poolInfoByIds(poolIds: string[]): Promise<PoolInfo[]> {
    if (poolIds.length === 0) return []
    const rows = await koios.batchAll(poolInfoRow, '/pool_info', poolIds, (chunk) => ({
      _pool_bech32_ids: chunk,
    }))
    const byId = new Map(rows.map((row) => [row.pool_id_bech32, row]))
    return poolIds.flatMap((id) => {
      const row = byId.get(id)
      return row ? [mapPoolInfo(row)] : []
    })
  }

  // Read every registered pool's id and active stake, following Koios's paging to the end.
  //
  // The whole set is needed before even the first page can be served, because the ordering
  // this endpoint promises is by active stake and that sort cannot be pushed upstream (see
  // getPoolList). So unlike the DRep list there is no early exit: page one of the result
  // still depends on the last pool read.
  async function registeredPoolStakes(ticker?: string): Promise<PoolStakeRow[]> {
    const rows: PoolStakeRow[] = []
    let after: string | undefined

    function pageQuery(limit: number): URLSearchParams {
      const query = new URLSearchParams({
        pool_status: 'eq.registered',
        // Order by id: unique and stable. A limit walk with no ORDER BY has no defined row
        // order upstream, so pages could overlap or leave gaps and a pool would be served
        // twice, or never. The stake sort still happens locally, because active_stake is a
        // text column upstream and ordering on it there sorts lexicographically.
        order: 'pool_id_bech32.asc',
        select: 'pool_id_bech32,active_stake',
        limit: String(limit),
      })
      // Keyset, not offset. Pools register and retire while this walk is in flight, and an
      // offset counts rows from the start every time: one pool leaving mid-walk slides the
      // whole tail up by one and the next page skips a pool that was never read. Anchoring
      // on the last id seen instead means the cursor survives anything happening behind it.
      if (after !== undefined) query.set('pool_id_bech32', `gt.${after}`)
      if (ticker !== undefined) query.set('ticker', `ilike.*${ticker}*`)
      return query
    }

    for (let page = 0; page < POOL_LIST_MAX_PAGES; page += 1) {
      const parsed = await koios.get(
        z.array(poolStakeRow),
        `/pool_list?${pageQuery(POOL_LIST_PAGE_SIZE).toString()}`,
      )
      rows.push(...parsed)

      // A short page is the end of the list upstream.
      if (parsed.length < POOL_LIST_PAGE_SIZE) return rows
      after = parsed[parsed.length - 1]?.pool_id_bech32
      if (after === undefined) return rows
    }

    // The cap ran out on a full page, which does not by itself mean anything was missed: a
    // list of exactly POOL_LIST_MAX_PAGES * POOL_LIST_PAGE_SIZE pools ends on a full page and
    // has been read in full. Ask for one more row to tell the two apart, rather than failing
    // a request that actually succeeded.
    const probe = await koios.get(z.array(poolStakeRow), `/pool_list?${pageQuery(1).toString()}`)
    if (probe.length === 0) return rows

    // There really are more. Every page of this endpoint is cut from the sorted whole, so a
    // truncated read does not merely shorten the tail: a missed pool with large stake would
    // be absent from page one. Say so rather than serve a quietly wrong ranking.
    throw new ProviderError(
      `koios /pool_list has more than ${POOL_LIST_MAX_PAGES * POOL_LIST_PAGE_SIZE} registered ` +
        `pools, beyond this provider's scan bound`,
    )
  }

  /**
   * The whole registered set, ordered by active stake, largest first.
   *
   * Cached on the **epoch**, not on a clock, because that is what `active_stake` is: the snapshot
   * the ledger uses for rewards, fixed for five days and then moving all at once. A duration would
   * be wrong in both directions, too short to be worth having across five days of identical
   * answers and too long to be right at the one moment the numbers move.
   *
   * A ticker search is deliberately **not** cached. It filters upstream, so each distinct search
   * term is a different scan and a different key, and caching an unbounded space of user-supplied
   * strings to serve a rare query is how a cache becomes a memory leak. Searches are uncommon and
   * can afford the scan.
   */
  async function rankedPools(ticker: string | undefined, epoch: number | undefined) {
    const scan = async (): Promise<PoolStakeRow[]> =>
      (await registeredPoolStakes(ticker)).sort(byActiveStakeDesc)

    if (ticker !== undefined || epoch === undefined) return scan()
    return cache.read(`pools:ranking:${epoch}`, RANKING_TTL_MS, scan)
  }

  async function servePage(
    { limit, offset, ticker }: PoolListParams,
    epoch: number | undefined,
  ): Promise<PoolInfo[]> {
    // Neutral ordering: registered pools by active stake, largest first, no promotional ranking.
    //
    // The sort has to happen here, not upstream. Koios stores active_stake as text, so ordering
    // on it in the query sorts lexicographically: a pool with 9_998_813_687 lovelace comes out
    // above one with 7_682_048_683_977, because '9' > '7'. Ordering by stake is this endpoint's
    // contract, so read the whole registered set (id and stake only, which is light), sort it
    // numerically, and hydrate just the requested page with full pool_info.
    const page = (await rankedPools(ticker, epoch)).slice(offset, offset + limit)
    const hydrated = await poolInfoByIds(page.map((r) => r.pool_id_bech32))

    // One snapshot, one truth: which pools are on this page, what order they come in, and
    // the activeStake each one reports all come from the same /pool_list read.
    //
    // Hydration is a second round trip, and across an epoch boundary its active_stake is a
    // different snapshot from the one the ranking was computed on. Two ways to get that
    // wrong, and this endpoint has now been through both:
    //
    //   - Rank on the snapshot but expose the hydrated stake, and a page goes out whose own
    //     activeStake values are not descending while it claims to be sorted by them.
    //   - Re-rank each page on its hydrated values, and the pages stop agreeing with each
    //     other: membership was still chosen from the snapshot, so two adjacent pages can
    //     come back in the wrong order relative to one another. That is worse. A list that
    //     is locally tidy and globally scrambled is harder to notice and harder to trust.
    //
    // So the snapshot wins outright. active_stake is an epoch-snapshot quantity to begin
    // with, so reporting the value the ranking actually used is not a compromise; it is the
    // more honest number. Every other field is hydrated as normal.
    //
    // Ranking on hydrated stake for the whole set would need every pool hydrated on every
    // request. See #62.
    const rankedStake = new Map(page.map((r) => [r.pool_id_bech32, String(r.active_stake ?? 0)]))
    return hydrated.map((pool) => ({
      ...pool,
      activeStake: rankedStake.get(pool.poolId) ?? pool.activeStake,
    }))
  }

  function serveUncached(params: PoolListParams, epoch: undefined): Promise<PoolInfo[]> {
    const { limit, offset, ticker } = params
    // Every caller-supplied page dimension belongs in the in-flight key; sharing a promise across
    // limits would return the first request's row count to the other caller.
    const key = `${ticker ?? ''}:${offset}:${limit}`
    const pending = uncachedInFlight.get(key)
    if (pending !== undefined) return pending

    const attempt = servePage(params, epoch).finally(() => {
      uncachedInFlight.delete(key)
    })
    uncachedInFlight.set(key, attempt)
    return attempt
  }

  return {
    getPoolInfo(poolIds: string[]): Promise<PoolInfo[]> {
      return poolInfoByIds(poolIds)
    },

    async getPoolList({ limit, offset, ticker }: PoolListParams): Promise<PoolInfo[]> {
      // The served page, cached briefly and served stale rather than failing.
      //
      // Page one is what nearly every client asks for, so this is the difference between one
      // /pool_info call every ninety seconds and one on every request. And /pool_info is the slow
      // part: on mainnet it answers in about 7 seconds when it is fast and 20 to 50 when it is
      // not, which is why a quarter of these requests currently fail outright.
      //
      // Keyed on the epoch as well as the page, so the ranking underneath cannot change without
      // the page key changing with it.
      const epoch = await cacheEpoch()
      if (epoch === undefined) return serveUncached({ limit, offset, ticker }, epoch)

      const key = `pools:page:${epoch}:${ticker ?? ''}:${offset}:${limit}`
      return cache.read(key, { ttlMs: PAGE_TTL_MS, staleIfErrorMs: PAGE_STALE_IF_ERROR_MS }, () =>
        servePage({ limit, offset, ticker }, epoch),
      )
    },
  }
}
