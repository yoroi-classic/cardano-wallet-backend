import type { TokenMetadata } from '../../domain/types/assets.js'

/** Native-token (asset) reads. */
export interface AssetCapability {
  /**
   * Metadata for a batch of native tokens, by CIP-26 subject (policy id + hex asset name).
   * Returns one entry per token the source knows about, in the input order; unknown
   * subjects are omitted, so the result is never longer than `subjects`.
   */
  getTokenMetadata(subjects: string[]): Promise<TokenMetadata[]>
}
