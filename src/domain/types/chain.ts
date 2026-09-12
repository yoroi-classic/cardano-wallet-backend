/** Chain-level domain shapes: where the chain is, and the parameters it runs under. */

/** Current chain tip. */
export interface Tip {
  /** Block height (block number). */
  block: number
  /** Absolute slot. */
  slot: number
  /** Epoch number. */
  epoch: number
  /** Block hash (hex). */
  hash: string
  /**
   * When the tip block was minted, as unix seconds.
   *
   * Carried because an absolute slot is not a timestamp: converting one to the other needs the
   * era boundaries of whichever network you are on, and getting that wrong yields a plausible
   * number rather than an error. `/v1/status` uses this to report how far behind the chain data
   * is, and a wallet can use it to show when it last saw the chain.
   */
  blockTime: number
}

/** Protocol version tuple. */
export interface ProtocolVersion {
  major: number
  minor: number
}

/**
 * Protocol parameters the wallet needs to build and evaluate transactions.
 * Lovelace-denominated values are strings to avoid precision loss.
 */
export interface ProtocolParams {
  epoch: number
  minFeeA: number
  minFeeB: number
  maxTxSize: number
  maxBlockBodySize: number
  keyDeposit: string
  poolDeposit: string
  minPoolCost: string
  coinsPerUtxoByte: string
  maxValueSize: number
  collateralPercent: number
  maxCollateralInputs: number
  priceMem: number
  priceStep: number
  maxTxExMem: string
  maxTxExSteps: string
  protocolVersion: ProtocolVersion
  /**
   * Plutus cost models keyed by language version. Kept as an opaque record because
   * the shape varies by era and provider, and the wallet passes it straight through
   * to the serialization library. Some providers (notably a bare Dingo node) omit
   * these, in which case they must be supplemented from another provider.
   */
  costModels: Record<string, unknown>
}
