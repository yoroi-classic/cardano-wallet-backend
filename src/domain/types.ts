/**
 * Normalized domain types. These are the shapes the backend exposes over its
 * public API, independent of whichever provider (Koios, Blockfrost, Dingo) served
 * the data. Providers map their own responses onto these.
 */

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

/** A native (non-ADA) asset held in a UTxO. */
export interface Asset {
  /** Policy id (hex). */
  policyId: string
  /** Asset name (hex). */
  assetName: string
  /** Quantity, as a string to avoid precision loss. */
  quantity: string
}

/** An unspent transaction output belonging to a wallet. */
export interface Utxo {
  /** Transaction hash (hex). */
  txHash: string
  /** Output index within that transaction. */
  outputIndex: number
  /** Bech32 address that controls the output. */
  address: string
  /** Lovelace value, as a string. */
  value: string
  /** Native assets in the output. */
  assets: Asset[]
  /** Datum hash (hex), if the output carries one. */
  datumHash?: string
  /** Inline datum (hex), if present. Needed by script-spending flows. */
  inlineDatum?: string
  /** Reference script hash (hex), if the output carries a reference script. */
  referenceScriptHash?: string
}

/** One side (input or output) of a transaction. */
export interface TxIo {
  /** Bech32 address, or empty when the provider can't express it (e.g. some Byron outputs). */
  address: string
  /** Lovelace value, as a string. */
  value: string
  /** Native assets carried on this input/output. */
  assets: Asset[]
}

/** A reward withdrawal within a transaction. */
export interface Withdrawal {
  stakeAddress: string
  amount: string
}

/** A certificate within a transaction, passed through in the provider's normalized form. */
export interface TxCertificate {
  /** Certificate kind (e.g. stake delegation, drep registration), as the provider labels it. */
  type: string
  /** Position of the certificate within the transaction. */
  index: number
  /** Kind-specific detail, shape varies, so it's opaque here. */
  info?: unknown
}

/** A historical transaction that touched the account, normalized for display. */
export interface WalletTransaction {
  txHash: string
  block: number
  blockHash: string
  slot: number
  epoch: number
  /** Unix timestamp (seconds) of the containing block. */
  blockTime: number
  fee: string
  /** Time-to-live (invalid-after slot), if the transaction set one. */
  ttl?: number
  inputs: TxIo[]
  outputs: TxIo[]
  withdrawals: Withdrawal[]
  certificates: TxCertificate[]
  /** Transaction metadata, opaque here. */
  metadata?: unknown
}

/** Confirmation status for a submitted transaction. */
export interface TxStatus {
  /** Whether the transaction has been seen on chain. */
  seen: boolean
  /** Number of confirmations (blocks on top), 0 if seen but not yet confirmed. */
  confirmations: number
}

/** Stake-account level state: balance, rewards, and current delegations. */
export interface AccountState {
  /** Bech32 stake address. */
  stakeAddress: string
  /** Whether the stake key is registered on chain. */
  registered: boolean
  /** Total controlled lovelace (UTxO plus withdrawable rewards), as a string. */
  balance: string
  /** Rewards available to withdraw, as a string. */
  rewardsAvailable: string
  /** Pool the account currently delegates to (bech32), if any. */
  delegatedPool?: string
  /** DRep the account currently delegates its vote to, if any. */
  delegatedDrep?: string
}
