import { z } from 'zod'
import type {
  PoolInfo,
  PoolListParams,
  PoolMetadata,
  PoolStatus,
} from '../../domain/types/pools.js'
import type { PoolCapability } from '../capabilities/pools.js'
import type { BlockfrostClient } from './client.js'
import { mapWithConcurrency } from './concurrency.js'
import { collectPages } from './pagination.js'
import { numeric } from './schema.js'

// Bounded fan-out for the per-pool hydration Blockfrost forces (no batch pool read), paced on top
// by the client's shared rate limiter. Same shape as filterUsedAddresses.
const POOL_LOOKUP_CONCURRENCY = 10

// A well-formed pool id, used as the map key hydration joins on and (from the extended list) as an
// opaque ranking cursor. A shape check, not a full bech32 decode: what matters is that it is a
// comparable pool id and not an empty string or a fragment of an error message. Caller-supplied ids
// are decoded properly, checksum and all, at the HTTP boundary.
const poolIdBech32 = z.string().regex(/^pool1[0-9a-z]+$/)

// Counts are whole and non-negative; a fractional delegator or a negative block count is upstream
// junk, routed to MalformedUpstreamError rather than let out through PoolInfo.
const count = z.number().int().nonnegative()

/** `pool` (Blockfrost OpenAPI spec, `/pools/{pool_id}`), projected to the fields we map. */
const poolRow = z.object({
  pool_id: poolIdBech32,
  hex: z.string().regex(/^[0-9a-fA-F]{56}$/),
  blocks_minted: count.nullish(),
  live_stake: numeric.nullish(),
  // Blockfrost reports saturation as a fraction already (0.93 == 93%), unlike Koios's percentage,
  // so it maps straight to the domain's fraction with no divide.
  live_saturation: z.number().nonnegative().nullish(),
  live_delegators: count.nullish(),
  active_stake: numeric.nullish(),
  declared_pledge: numeric.nullish(),
  live_pledge: numeric.nullish(),
  // An operator margin is a fraction of rewards, so it lives in [0, 1] by definition.
  margin_cost: z.number().min(0).max(1),
  fixed_cost: numeric.nullish(),
  // The registration and retirement certificate histories. Blockfrost's pool object carries no
  // status enum, so the current lifecycle is inferred from these; see poolStatus.
  registration: z.array(z.string()),
  retirement: z.array(z.string()),
})

const poolMetadataRow = z.object({
  ticker: z.string().nullish(),
  name: z.string().nullish(),
  homepage: z.string().nullish(),
  description: z.string().nullish(),
})

/** One row of `pool_list_extended` (`/pools/extended`), projected to what the ranking and the
 * ticker filter need. The extended list carries the pool's metadata inline, so the ticker filter
 * needs no per-pool round trip. */
const poolExtendedRow = z.object({
  pool_id: poolIdBech32,
  active_stake: numeric.nullish(),
  metadata: z.object({ ticker: z.string().nullish() }).nullish(),
})

type PoolExtendedRow = z.infer<typeof poolExtendedRow>

function activeStakeOf(row: PoolExtendedRow): bigint {
  return row.active_stake == null ? 0n : BigInt(row.active_stake)
}

// Largest active stake first. Ties break on pool id so the order is total and paging stays stable:
// without it, equally-staked pools could shuffle between calls and the same pool be served twice,
// or skipped, across two pages. Identical contract to the Koios driver's own list ordering.
function byActiveStakeDesc(a: PoolExtendedRow, b: PoolExtendedRow): number {
  const left = activeStakeOf(a)
  const right = activeStakeOf(b)
  if (left !== right) return left > right ? -1 : 1
  return a.pool_id < b.pool_id ? -1 : a.pool_id > b.pool_id ? 1 : 0
}

/**
 * Current lifecycle, inferred from the certificate histories.
 *
 * Blockfrost's pool object exposes no status enum and no retirement epoch (Koios exposes both), so
 * the state is read from the counts: a pool with more registrations than retirements has a live
 * registration not yet retired, otherwise its last registration has been retired. What this cannot
 * see is a filed-but-not-yet-effective retirement, so `retiring` is not distinguished from
 * `retired`, and `retiringEpoch` is always absent. A follow-up wanting exact parity would cross-
 * reference `/pools/retiring`.
 */
function poolStatus(row: z.infer<typeof poolRow>): PoolStatus {
  return row.registration.length > row.retirement.length ? 'registered' : 'retired'
}

function mapPoolMetadata(m: z.infer<typeof poolMetadataRow>): PoolMetadata | undefined {
  const md: PoolMetadata = {}
  if (m.name != null) md.name = m.name
  if (m.ticker != null) md.ticker = m.ticker
  if (m.homepage != null) md.homepage = m.homepage
  if (m.description != null) md.description = m.description
  return Object.keys(md).length > 0 ? md : undefined
}

function mapPoolInfo(row: z.infer<typeof poolRow>, metadata: PoolMetadata | undefined): PoolInfo {
  return {
    poolId: row.pool_id,
    poolIdHex: row.hex,
    status: poolStatus(row),
    // Blockfrost exposes no retirement epoch; see poolStatus.
    retiringEpoch: undefined,
    margin: row.margin_cost,
    fixedCost: String(row.fixed_cost ?? 0),
    pledge: String(row.declared_pledge ?? 0),
    livePledge: String(row.live_pledge ?? 0),
    activeStake: String(row.active_stake ?? 0),
    liveStake: String(row.live_stake ?? 0),
    // Already a fraction upstream (1.0 == saturated), unlike Koios's percentage.
    saturation: row.live_saturation ?? 0,
    liveDelegators: row.live_delegators ?? 0,
    blocksMinted: row.blocks_minted ?? 0,
    metadata,
  }
}

export function createPoolMethods(client: BlockfrostClient): PoolCapability {
  // Hydrate a set of pool ids with full pool info plus best-effort off-chain metadata, preserving
  // input order. An unknown id answers 404 -> `undefined` -> absent, so the result is never longer
  // than the input. One paced, bounded-concurrency pair of reads per pool.
  async function poolInfoByIds(poolIds: string[]): Promise<PoolInfo[]> {
    if (poolIds.length === 0) return []
    const mapped = await mapWithConcurrency(poolIds, POOL_LOOKUP_CONCURRENCY, async (id) => {
      const row = await client.getOrUndefined(poolRow, `/pools/${encodeURIComponent(id)}`)
      if (row === undefined) return undefined
      const metadata = await poolMetadata(id)
      return mapPoolInfo(row, metadata)
    })
    return mapped.filter((pool): pool is PoolInfo => pool !== undefined)
  }

  // Off-chain pool metadata, best-effort: a pool without metadata (or a metadata endpoint that
  // misbehaves) still resolves, it just has no ticker/name. A pool that registered no metadata
  // answers 404 -> `undefined`.
  async function poolMetadata(poolId: string): Promise<PoolMetadata | undefined> {
    try {
      const row = await client.getOrUndefined(
        poolMetadataRow,
        `/pools/${encodeURIComponent(poolId)}/metadata`,
      )
      return row === undefined ? undefined : mapPoolMetadata(row)
    } catch {
      return undefined
    }
  }

  return {
    getPoolInfo(poolIds: string[]): Promise<PoolInfo[]> {
      return poolInfoByIds(poolIds)
    },

    async getPoolList({ limit, offset, ticker }: PoolListParams): Promise<PoolInfo[]> {
      if (limit <= 0) return []

      // Neutral ordering: registered pools by active stake, largest first, no promotional ranking.
      // The sort cannot be pushed upstream (Blockfrost's list is not stake-ordered), so the whole
      // registered set is read light — id, stake, and the inline ticker only — then sorted here and
      // just the requested page hydrated with full pool info, the same two-phase shape the Koios
      // driver uses. `/pools/extended` lists active pools, so the page is registered by construction.
      const extended = await collectPages(
        client,
        poolExtendedRow,
        '/pools/extended',
        Number.POSITIVE_INFINITY,
        { label: '/pools/extended' },
      )

      // Ticker filter honored on the inline metadata, so no per-pool round trip is needed to filter
      // (Blockfrost's list carries the ticker; Koios has to join it). Case-insensitive substring,
      // matching Koios's `ilike`.
      const needle = ticker?.toLowerCase()
      const filtered =
        needle === undefined
          ? extended
          : extended.filter((row) => {
              const t = row.metadata?.ticker
              return typeof t === 'string' && t.toLowerCase().includes(needle)
            })

      const page = filtered.sort(byActiveStakeDesc).slice(offset, offset + limit)
      const hydrated = await poolInfoByIds(page.map((row) => row.pool_id))

      // One snapshot, one truth: expose the active stake the ranking actually used, not the value
      // re-read during hydration, so a page sorted by active stake cannot go out with its own
      // activeStake values contradicting that order across an epoch boundary. Same reasoning as the
      // Koios driver.
      const rankedStake = new Map(page.map((row) => [row.pool_id, String(row.active_stake ?? 0)]))
      return hydrated.map((pool) => ({
        ...pool,
        activeStake: rankedStake.get(pool.poolId) ?? pool.activeStake,
      }))
    },
  }
}
