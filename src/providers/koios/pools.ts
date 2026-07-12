import { z } from 'zod'
import { ProviderError } from '../../domain/errors.js'
import type { PoolInfo, PoolListParams, PoolMetadata } from '../../domain/types/pools.js'
import type { PoolCapability } from '../capabilities/pools.js'
import type { KoiosClient } from './client.js'
import { chunked, numeric } from './schema.js'

// Koios rejects a /pool_info body carrying 100 ids with a 413, so hydrate in smaller
// batches. 50 leaves room for the id set to grow without brushing the limit again.
const POOL_INFO_CHUNK = 50
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

export function createPoolMethods(koios: KoiosClient): PoolCapability {
  // Hydrate a set of pool ids with full pool_info, preserving the input order. Unknown ids
  // are simply absent from Koios, so the result is never longer than the input.
  //
  // Koios rejects an oversized request body with a 413, and a single batch of 100 ids is
  // already over that limit, so the ids are hydrated in chunks and stitched back together.
  async function poolInfoByIds(poolIds: string[]): Promise<PoolInfo[]> {
    if (poolIds.length === 0) return []
    const byId = new Map<string, z.infer<typeof poolInfoRow>>()
    for (const chunk of chunked(poolIds, POOL_INFO_CHUNK)) {
      const data = await koios.postJson('/pool_info', { _pool_bech32_ids: chunk })
      const rows = koios.parseWith(z.array(poolInfoRow), data, '/pool_info')
      for (const row of rows) byId.set(row.pool_id_bech32, row)
    }
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
      const data = await koios.request(`/pool_list?${pageQuery(POOL_LIST_PAGE_SIZE).toString()}`)
      const parsed = koios.parseWith(z.array(poolStakeRow), data, '/pool_list')
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
    const probe = await koios.request(`/pool_list?${pageQuery(1).toString()}`)
    if (koios.parseWith(z.array(poolStakeRow), probe, '/pool_list').length === 0) return rows

    // There really are more. Every page of this endpoint is cut from the sorted whole, so a
    // truncated read does not merely shorten the tail: a missed pool with large stake would
    // be absent from page one. Say so rather than serve a quietly wrong ranking.
    throw new ProviderError(
      `koios /pool_list has more than ${POOL_LIST_MAX_PAGES * POOL_LIST_PAGE_SIZE} registered ` +
        `pools, beyond this provider's scan bound`,
    )
  }

  return {
    getPoolInfo(poolIds: string[]): Promise<PoolInfo[]> {
      return poolInfoByIds(poolIds)
    },

    async getPoolList({ limit, offset, ticker }: PoolListParams): Promise<PoolInfo[]> {
      // Neutral ordering: registered pools by active stake, largest first, no promotional
      // ranking.
      //
      // The sort has to happen here, not upstream. Koios stores active_stake as text, so
      // ordering on it in the query sorts lexicographically: a pool with 9_998_813_687
      // lovelace comes out above one with 7_682_048_683_977, because '9' > '7'. Ordering
      // by stake is this endpoint's contract, so read the whole registered set (id and
      // stake only, which is light), sort it numerically, and hydrate just the requested
      // page with full pool_info.
      const stakes = await registeredPoolStakes(ticker)
      const page = stakes.sort(byActiveStakeDesc).slice(offset, offset + limit)
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
    },
  }
}
