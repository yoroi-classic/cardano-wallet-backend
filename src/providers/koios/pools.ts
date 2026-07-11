import { z } from 'zod'
import type { PoolInfo, PoolMetadata } from '../../domain/types/pools.js'
import type { PoolCapability } from '../capabilities/pools.js'
import type { KoiosClient } from './client.js'
import { numeric } from './schema.js'

const poolMetaJson = z.object({
  name: z.string().nullish(),
  ticker: z.string().nullish(),
  homepage: z.string().nullish(),
  description: z.string().nullish(),
})

const poolInfoRow = z.object({
  pool_id_bech32: z.string(),
  pool_id_hex: z.string(),
  // Koios documents exactly these three; anything else is unexpected upstream data.
  pool_status: z.enum(['registered', 'retiring', 'retired']),
  retiring_epoch: z.number().nullish(),
  margin: z.number(),
  fixed_cost: numeric.nullish(),
  pledge: numeric.nullish(),
  live_pledge: numeric.nullish(),
  active_stake: numeric.nullish(),
  live_stake: numeric.nullish(),
  // Koios reports saturation as a percentage (e.g. 3.12 == 3.12%); normalize to a fraction.
  live_saturation: z.number().nullish(),
  live_delegators: z.number().nullish(),
  block_count: z.number().nullish(),
  meta_json: poolMetaJson.nullish(),
})

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
  return {
    async getPoolInfo(poolIds: string[]): Promise<PoolInfo[]> {
      if (poolIds.length === 0) return []
      const data = await koios.postJson('/pool_info', { _pool_bech32_ids: poolIds })
      const rows = koios.parseWith(z.array(poolInfoRow), data, '/pool_info')
      const byId = new Map(rows.map((r) => [r.pool_id_bech32, r]))
      // Return in the caller's order; unknown pool ids are simply absent from Koios.
      return poolIds.flatMap((id) => {
        const row = byId.get(id)
        return row ? [mapPoolInfo(row)] : []
      })
    },
  }
}
