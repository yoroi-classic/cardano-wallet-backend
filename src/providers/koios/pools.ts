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

// Pools with no active stake sort last, so give them a value below every real stake.
const NO_ACTIVE_STAKE = -1n

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
  pool_id_bech32: z.string(),
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
  pool_id_bech32: z.string(),
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
    for (let page = 0; page < POOL_LIST_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        pool_status: 'eq.registered',
        // A limit/offset walk with no ORDER BY has no defined row order upstream, so pages
        // can overlap or leave gaps, and a pool would be served twice or never seen at all.
        // Order by id: it is unique and stable. The stake sort still happens locally
        // afterwards, because active_stake is a text column upstream and ordering on it
        // there would sort lexicographically.
        order: 'pool_id_bech32.asc',
        select: 'pool_id_bech32,active_stake',
        limit: String(POOL_LIST_PAGE_SIZE),
        offset: String(page * POOL_LIST_PAGE_SIZE),
      })
      if (ticker !== undefined) query.set('ticker', `ilike.*${ticker}*`)
      const data = await koios.request(`/pool_list?${query.toString()}`)
      const parsed = koios.parseWith(z.array(poolStakeRow), data, '/pool_list')
      rows.push(...parsed)

      // A short page is the end of the list upstream.
      if (parsed.length < POOL_LIST_PAGE_SIZE) return rows
    }

    // The page cap ran out while upstream was still handing back full pages, so there are
    // more registered pools than were read. Every page here is cut from the sorted whole, so
    // a truncated read does not merely shorten the tail: a missed pool with large stake would
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
      return poolInfoByIds(page.map((r) => r.pool_id_bech32))
    },
  }
}
