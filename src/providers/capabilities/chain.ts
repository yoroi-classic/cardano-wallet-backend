import type { ProtocolParams, Tip } from '../../domain/types/chain.js'

/** Chain-level reads: where the chain is, and the parameters it runs under. */
export interface ChainCapability {
  /** Current chain tip. */
  getTip(): Promise<Tip>

  /** Protocol parameters for the latest epoch. */
  getProtocolParams(): Promise<ProtocolParams>
}
