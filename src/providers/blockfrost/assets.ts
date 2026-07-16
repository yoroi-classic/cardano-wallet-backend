import type { TokenMetadata } from '../../domain/types/assets.js'
import type { AssetCapability } from '../capabilities/assets.js'
import { notImplemented } from './not-implemented.js'

/**
 * Native-token metadata is not part of this driver's first pass.
 *
 * Blockfrost's `/assets/{asset}` maps onto the same registry / CIP-25 / CIP-68 fallback chain
 * the Koios driver already implements (see src/providers/koios/assets.ts), but hydrating those
 * three sources correctly is real, independently-tested work, not a thin wrapper over one
 * endpoint. Out of scope for the six-endpoint proof of viability this PR ships; see issue #4's
 * status comment.
 */
export function createAssetMethods(): AssetCapability {
  return {
    // async, even though it never awaits anything: notImplemented() throws synchronously, and
    // only an async function turns that into a rejected promise rather than a synchronous throw
    // escaping the call before a caller's `await` ever gets to see it.
    async getTokenMetadata(_subjects: string[]): Promise<TokenMetadata[]> {
      return notImplemented('getTokenMetadata')
    },
  }
}
