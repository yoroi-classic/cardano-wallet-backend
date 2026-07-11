import type { PoolInfo, PoolListParams } from '../../domain/types/pools.js'

/** Stake-pool reads. */
export interface PoolCapability {
  /**
   * Information for a batch of stake pools, by bech32 pool id. Returns one entry per pool
   * the source knows about, in the input order; unknown pool ids are omitted, so the
   * result is never longer than `poolIds`.
   */
  getPoolInfo(poolIds: string[]): Promise<PoolInfo[]>

  /**
   * A page of registered stake pools, ordered by active stake, largest first. Neutral by
   * construction: no promotional ranking, and no pool is given a house position.
   */
  getPoolList(params: PoolListParams): Promise<PoolInfo[]>
}
