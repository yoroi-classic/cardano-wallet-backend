import type { PoolInfo } from '../../domain/types/pools.js'

/** Stake-pool reads. */
export interface PoolCapability {
  /**
   * Information for a batch of stake pools, by bech32 pool id. Returns one entry per pool
   * the source knows about, in the input order; unknown pool ids are omitted, so the
   * result is never longer than `poolIds`.
   */
  getPoolInfo(poolIds: string[]): Promise<PoolInfo[]>
}
