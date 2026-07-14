/** Transaction-level domain shapes: outputs, history, certificates, and submission status. */

import type { Asset } from './common.js'

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
  /** Bech32 address. Omitted when the provider can't express it (e.g. some Byron outputs). */
  address?: string
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

/**
 * Normalized, provider-agnostic certificate kind. Providers map their own labels onto
 * this stable set so the API shape doesn't leak Koios (or Blockfrost) terminology.
 */
export type CertificateKind =
  | 'stake_registration'
  | 'stake_deregistration'
  | 'stake_delegation'
  | 'pool_registration'
  | 'pool_retirement'
  | 'vote_delegation'
  | 'drep_registration'
  | 'drep_update'
  | 'drep_deregistration'
  | 'committee_hot_auth'
  | 'committee_cold_resign'
  | 'move_instantaneous_rewards'
  | 'genesis_key_delegation'
  | 'other'

/**
 * A certificate within a transaction. Only the normalized kind and position are exposed
 * for now, so the contract stays provider-agnostic. Per-kind normalized detail (pool id,
 * stake address, etc.) is a planned addition once we normalize it across providers.
 */
export interface TxCertificate {
  /** Normalized certificate kind. */
  kind: CertificateKind
  /** Position of the certificate within the transaction. */
  index: number
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

/**
 * A UTxO resolved by its output reference, rather than by who controls it.
 *
 * The extra field over `Utxo` is `spent`, and it is the whole reason this type exists. The UTxOs
 * on `/v1/account/{stake}/utxos` are unspent by construction: that endpoint answers "what does
 * this wallet control", and a spent output is not controlled by anyone. A lookup *by reference*
 * is a different question, asked by a dApp connector resolving a transaction's inputs or by a
 * wallet checking a collateral input it set aside earlier, and for those the answer "this exists
 * but is gone" is the important one.
 *
 * Omitting it would be worse than useless. Collateral has to be an unspent, pure-ADA output; a
 * wallet that offered a spent one would build a transaction the node rejects, and the user would
 * see a failure with no explanation.
 */
export interface ResolvedUtxo extends Utxo {
  /** Whether the output has since been consumed. An unspent output is the usable one. */
  spent: boolean
}
