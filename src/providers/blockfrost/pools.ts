import { z } from 'zod'
import { noCache, type Cache } from '../../cache/index.js'
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

/**
 * The ranking is the epoch snapshot the pools are ordered by, so it is keyed on the epoch and not a
 * clock. This TTL is only a memory bound: it has to outlive an epoch (five days) so the entry
 * survives exactly as long as its key is current, and no longer. Identical to the Koios driver.
 */
const RANKING_TTL_MS = 6 * 24 * 60 * 60 * 1000

/**
 * A served page, cached briefly. This is the part that is not epoch-fixed: a hydrated pool carries
 * `liveStake`, `saturation` and `liveDelegators`, which drift continuously, so caching them for
 * five days would show stale figures on the one screen where they matter. Ninety seconds of drift
 * is imperceptible; re-hydrating a page on every request is not, because each pool is two upstream
 * calls with no batch form. Same values and reasoning as the Koios driver.
 */
const PAGE_TTL_MS = 90_000
const PAGE_STALE_IF_ERROR_MS = 10 * 60_000

// A well-formed pool id, used as the map key hydration joins on and (from the extended list) as an
// opaque ranking cursor. A shape check, not a full bech32 decode.
const poolIdBech32 = z.string().regex(/^pool1[0-9a-z]+$/)

// Counts are whole and non-negative; a fractional delegator or a negative block count is upstream
// junk, routed to MalformedUpstreamError rather than let out through PoolInfo.
const count = z.number().int().nonnegative()

// The off-chain metadata fields, shared by the `/pools/{id}/metadata` endpoint and the copy the
// extended list carries inline. The extended list also carries `url`/`hash`, which are not mapped.
const poolMetaFields = z.object({
  ticker: z.string().nullish(),
  name: z.string().nullish(),
  homepage: z.string().nullish(),
  description: z.string().nullish(),
})

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
  // status enum, so the current lifecycle is inferred from these plus the retiring set; see
  // poolStatus.
  registration: z.array(z.string()),
  retirement: z.array(z.string()),
})

const poolMetadataRow = poolMetaFields

/** One row of `pool_list_extended` (`/pools/extended`), projected to what the ranking, the ticker
 * filter, and hydration need. The extended list carries the pool's metadata inline, so neither the
 * filter nor hydration needs a separate `/metadata` round trip for a listed pool. */
const poolExtendedRow = z.object({
  pool_id: poolIdBech32,
  active_stake: numeric.nullish(),
  metadata: poolMetaFields.nullish(),
})

type PoolExtendedRow = z.infer<typeof poolExtendedRow>

/** One row of `pool_list_retire` (`/pools/retiring`): a pool with a scheduled future retirement. */
const poolRetireRow = z.object({
  pool_id: poolIdBech32,
  epoch: count,
})

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
 * Current lifecycle.
 *
 * Blockfrost's pool object exposes no status enum and no retirement epoch (Koios exposes both). A
 * pool with a scheduled future retirement is named by `/pools/retiring` along with the epoch it
 * retires in, so `retiringEpoch` present means the pool is `retiring`. Otherwise the state is read
 * from the certificate counts: more registrations than retirements means a live registration not
 * yet retired, otherwise the last registration has been retired.
 */
function poolStatus(row: z.infer<typeof poolRow>, retiringEpoch: number | undefined): PoolStatus {
  if (retiringEpoch !== undefined) return 'retiring'
  return row.registration.length > row.retirement.length ? 'registered' : 'retired'
}

function mapPoolMetadata(
  m: z.infer<typeof poolMetaFields> | null | undefined,
): PoolMetadata | undefined {
  if (!m) return undefined
  const md: PoolMetadata = {}
  if (m.name != null) md.name = m.name
  if (m.ticker != null) md.ticker = m.ticker
  if (m.homepage != null) md.homepage = m.homepage
  if (m.description != null) md.description = m.description
  return Object.keys(md).length > 0 ? md : undefined
}

function mapPoolInfo(
  row: z.infer<typeof poolRow>,
  metadata: PoolMetadata | undefined,
  retiringEpoch: number | undefined,
): PoolInfo {
  return {
    poolId: row.pool_id,
    poolIdHex: row.hex,
    status: poolStatus(row, retiringEpoch),
    retiringEpoch,
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

export interface PoolMethodDeps {
  /** Cache for the epoch-keyed ranking and for served pages. Defaults to none. */
  cache?: Cache
  /**
   * The current epoch, from the same cached tip the rest of the service uses. The ranking is keyed
   * on it, so it must be the epoch everyone else believes in. Absent means "serve it uncached".
   */
  currentEpoch?: () => Promise<number>
}

export function createPoolMethods(
  client: BlockfrostClient,
  deps: PoolMethodDeps = {},
): PoolCapability {
  const cache = deps.cache ?? noCache

  /**
   * The epoch to key the cache on, or `undefined` if we could not find out. The epoch is a cache
   * key and nothing else, so a failure to read it must not become a failure to serve the pool list.
   */
  async function cacheEpoch(): Promise<number | undefined> {
    if (deps.currentEpoch === undefined) return undefined
    try {
      return await deps.currentEpoch()
    } catch {
      return undefined
    }
  }

  // The pools with a scheduled future retirement, keyed to the epoch each retires in. A small list
  // (a handful of pools), read once per uncached page so `retiring` can be told from `retired`.
  async function retiringPools(): Promise<Map<string, number>> {
    // Best-effort enrichment: `/pools/retiring` only refines `retiring` vs `retired` and supplies
    // the retiring epoch. If it cannot be read (a rate-limit, a timeout, a 5xx), a pool's core data
    // is still good, so this returns an empty map and the status falls back to the certificate-count
    // heuristic rather than failing the whole pool read. A pool actually retiring is then reported
    // as `retired` until the endpoint recovers, which is a lesser wrong than no pool at all.
    try {
      const rows = await collectPages(
        client,
        poolRetireRow,
        '/pools/retiring',
        Number.POSITIVE_INFINITY,
        { label: '/pools/retiring' },
      )
      // A pool can carry more than one retirement certificate over its life; the last one listed is
      // its current scheduled epoch.
      return new Map(rows.map((row) => [row.pool_id, row.epoch]))
    } catch {
      return new Map()
    }
  }

  // Off-chain pool metadata, best-effort: a pool without metadata (or a metadata endpoint that
  // misbehaves) still resolves. A pool that registered no metadata answers 404 -> `undefined`.
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

  // Hydrate a set of pool ids with full pool info plus off-chain metadata, preserving input order.
  // An unknown id answers 404 -> `undefined` -> absent, so the result is never longer than the
  // input. When `inlineMetadata` already holds a pool's metadata (the list path, from
  // `/pools/extended`), no `/metadata` call is made for it; otherwise one is, best-effort.
  async function poolInfoByIds(
    poolIds: string[],
    retiring: Map<string, number>,
    inlineMetadata?: Map<string, PoolMetadata | undefined>,
  ): Promise<PoolInfo[]> {
    if (poolIds.length === 0) return []
    const mapped = await mapWithConcurrency(poolIds, POOL_LOOKUP_CONCURRENCY, async (id) => {
      const row = await client.getOrUndefined(poolRow, `/pools/${encodeURIComponent(id)}`)
      if (row === undefined) return undefined
      const metadata = inlineMetadata?.has(id) ? inlineMetadata.get(id) : await poolMetadata(id)
      return mapPoolInfo(row, metadata, retiring.get(id))
    })
    return mapped.filter((pool): pool is PoolInfo => pool !== undefined)
  }

  /**
   * The whole registered set, id + stake + inline metadata, ordered by active stake (largest
   * first). Cached on the epoch, not a clock, because that is what `active_stake` is: the ledger's
   * reward snapshot, fixed for five days and then moving all at once.
   *
   * The ranking is ticker-independent, so it is cached once per epoch and the ticker filter is
   * applied to the cached set afterwards. That is safe where caching per-ticker would not be: one
   * key per epoch, rather than an unbounded key space of user-supplied search terms.
   */
  async function rankedPools(epoch: number | undefined): Promise<PoolExtendedRow[]> {
    const scan = async (): Promise<PoolExtendedRow[]> =>
      (
        await collectPages(client, poolExtendedRow, '/pools/extended', Number.POSITIVE_INFINITY, {
          label: '/pools/extended',
        })
      ).sort(byActiveStakeDesc)

    if (epoch === undefined) return scan()
    return cache.read(`pools:ranking:${epoch}`, RANKING_TTL_MS, scan)
  }

  async function servePage(
    { limit, offset, ticker }: PoolListParams,
    epoch: number | undefined,
  ): Promise<PoolInfo[]> {
    const ranked = await rankedPools(epoch)
    // Ticker filter honored on the inline metadata (Blockfrost's extended list carries it; Koios
    // has to join it), so no per-pool round trip is needed to filter. Case-insensitive substring,
    // matching Koios's `ilike`.
    const needle = ticker?.toLowerCase()
    const filtered =
      needle === undefined
        ? ranked
        : ranked.filter((row) => {
            const t = row.metadata?.ticker
            return typeof t === 'string' && t.toLowerCase().includes(needle)
          })

    const page = filtered.slice(offset, offset + limit)
    const retiring = await retiringPools()
    const inlineMetadata = new Map(page.map((row) => [row.pool_id, mapPoolMetadata(row.metadata)]))
    const hydrated = await poolInfoByIds(
      page.map((row) => row.pool_id),
      retiring,
      inlineMetadata,
    )

    // One snapshot, one truth: expose the active stake the ranking actually used, not the value
    // re-read during hydration, so a page sorted by active stake cannot go out with its own
    // activeStake values contradicting that order across an epoch boundary. Same reasoning as the
    // Koios driver.
    const rankedStake = new Map(page.map((row) => [row.pool_id, String(row.active_stake ?? 0)]))
    return hydrated.map((pool) => ({
      ...pool,
      activeStake: rankedStake.get(pool.poolId) ?? pool.activeStake,
    }))
  }

  return {
    async getPoolInfo(poolIds: string[]): Promise<PoolInfo[]> {
      if (poolIds.length === 0) return []
      const retiring = await retiringPools()
      // No inline metadata for an arbitrary lookup, so each pool's metadata is fetched best-effort.
      return poolInfoByIds(poolIds, retiring)
    },

    async getPoolList({ limit, offset, ticker }: PoolListParams): Promise<PoolInfo[]> {
      if (limit <= 0) return []

      // The served page, cached briefly and served stale rather than failing. Page one is what
      // nearly every client asks for, so this is the difference between one full ranking scan plus a
      // hydration fan-out every ninety seconds and one on every request. Keyed on the epoch as well
      // as the page, so the ranking underneath cannot change without the key changing with it.
      const epoch = await cacheEpoch()
      const key = `pools:page:${epoch ?? 'none'}:${ticker ?? ''}:${offset}:${limit}`
      return cache.read(key, { ttlMs: PAGE_TTL_MS, staleIfErrorMs: PAGE_STALE_IF_ERROR_MS }, () =>
        servePage({ limit, offset, ticker }, epoch),
      )
    },
  }
}
