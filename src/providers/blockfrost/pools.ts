import type { PoolInfo, PoolListParams } from '../../domain/types/pools.js'
import type { PoolCapability } from '../capabilities/pools.js'
import { notImplemented } from './not-implemented.js'

/**
 * Stake-pool reads are not part of this driver's first pass.
 *
 * Blockfrost has `/pools` and `/pools/{pool_id}`, but the neutral, stable-paged ranking by
 * active stake (see the Koios driver's own `getPoolList`) is a capability area of its own, out
 * of scope for the six-endpoint proof of viability this PR ships. See issue #4's status comment.
 */
export function createPoolMethods(): PoolCapability {
  return {
    // async so notImplemented()'s synchronous throw becomes a rejected promise rather than
    // escaping the call before a caller's `await` sees it. See the note in assets.ts.
    async getPoolInfo(_poolIds: string[]): Promise<PoolInfo[]> {
      return notImplemented('getPoolInfo')
    },

    async getPoolList(_params: PoolListParams): Promise<PoolInfo[]> {
      return notImplemented('getPoolList')
    },
  }
}
