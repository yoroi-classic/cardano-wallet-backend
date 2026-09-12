/** Stake-pool domain shapes. */

/**
 * Off-chain pool metadata, as registered on chain (SMASH-style). All fields optional
 * because a pool may register without metadata, or omit individual fields.
 */
export interface PoolMetadata {
  name?: string
  ticker?: string
  homepage?: string
  description?: string
}

/** Registration lifecycle of a stake pool. */
export type PoolStatus = 'registered' | 'retiring' | 'retired'

/**
 * Normalized stake-pool information: registration parameters, off-chain metadata, and
 * current stake/saturation stats. Lovelace values are strings to avoid precision loss.
 */
export interface PoolInfo {
  /** Bech32 pool id (pool1...). */
  poolId: string
  /** Pool id as a hex key-hash. */
  poolIdHex: string
  status: PoolStatus
  /** Epoch the pool is set to retire in, when `status` is `retiring`. */
  retiringEpoch?: number
  /** Operator margin, as a fraction in [0, 1]. */
  margin: number
  /** Fixed operator cost per epoch, in lovelace. */
  fixedCost: string
  /** Declared pledge, in lovelace. */
  pledge: string
  /** Pledge actually met by owner stake right now, in lovelace. */
  livePledge: string
  /** Active (epoch-snapshot) stake, in lovelace. */
  activeStake: string
  /** Live stake, in lovelace. */
  liveStake: string
  /** Fraction of the saturation cap, where 1.0 is fully saturated. */
  saturation: number
  /** Number of live delegators. */
  liveDelegators: number
  /** Lifetime blocks minted. */
  blocksMinted: number
  /** Off-chain metadata, when the pool registered any. */
  metadata?: PoolMetadata
}

/** Query for a page of the stake-pool list. */
export interface PoolListParams {
  /** Maximum pools to return. */
  limit: number
  /** How many pools to skip, for paging. */
  offset: number
  /** Case-insensitive ticker substring filter, when present. */
  ticker?: string
}
