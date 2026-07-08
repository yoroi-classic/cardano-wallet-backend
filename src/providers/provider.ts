import type { ProtocolParams, Tip } from '../domain/types.js'

/**
 * The provider contract. Every data source (Koios, Blockfrost, a bring-your-own
 * Dingo node) implements this so the HTTP layer never has to know which one is
 * serving a request. The interface grows one capability at a time as endpoints
 * land; today it covers the chain-tip and protocol-parameter reads.
 */
export interface ChainProvider {
  /** A short name for logs and diagnostics, e.g. "koios". */
  readonly name: string

  /** Current chain tip. */
  getTip(): Promise<Tip>

  /** Protocol parameters for the latest epoch. */
  getProtocolParams(): Promise<ProtocolParams>
}
