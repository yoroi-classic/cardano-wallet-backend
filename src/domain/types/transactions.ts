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
  /**
   * Height of the block that *created* this output.
   *
   * Authoritative provenance, read from the upstream that knows it, never inferred from the
   * current tip or from when we happened to observe the output. A client persisting a UTxO set
   * needs the creation height to reason about the age of what it holds, and stamping a whole
   * snapshot with the tip makes every output look as new as the read that fetched it.
   */
  blockHeight: number
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

/**
 * One consumed input of a transaction, carrying the output it spent.
 *
 * The reference is what separates this from a bare `TxIo`, and it is the whole reason the type
 * exists. Address and value alone do not identify a spent output: a transaction can consume two
 * outputs with the same address and the same value, and nothing in the pair distinguishes them.
 * A client reconstructing history has to match each input to the output it consumed, and without
 * the reference its only options are to guess by address and amount, or to fail closed.
 *
 * Outputs do not carry one. An output's own reference is the containing transaction's hash and its
 * position, both of which the caller already holds, whereas an input points at a *different*
 * transaction and cannot be derived from anything else in the response.
 */
export interface TxInput extends TxIo {
  /** Hash of the transaction that created the consumed output. */
  txHash: string
  /** Index of the consumed output within that transaction. */
  outputIndex: number
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
  inputs: TxInput[]
  outputs: TxIo[]
  withdrawals: Withdrawal[]
  certificates: TxCertificate[]
  /** Transaction metadata, opaque here. */
  metadata?: unknown
}

/** A stable, provider-neutral code for a provable terminal failure. */
export type TxTerminalCode = 'TX_REJECTED' | 'TX_EXPIRED'

/** A sanitized terminal failure. Provider response text never crosses this boundary. */
export interface TxTerminalReason {
  code: TxTerminalCode
  reason: string
}

interface TxInconclusiveStatus {
  /** `pending` is positively present in a mempool; `unknown` is merely absent from known sources. */
  status: 'pending' | 'unknown'
  /** Kept for backwards compatibility. Inconclusive transactions are not on chain. */
  seen: false
  confirmations: 0
  /** An inconclusive read must never make a wallet expose the inputs again. */
  overlayAction: 'retain'
}

interface TxConfirmedStatus {
  status: 'confirmed'
  seen: true
  /** Number of blocks on top. A transaction in the tip block has zero confirmations. */
  confirmations: number
  /** Refresh authoritative UTxOs, then remove the overlay once that state includes the tx. */
  overlayAction: 'reconcile'
}

interface TxRejectedStatus {
  status: 'rejected'
  seen: false
  confirmations: 0
  /** Only a provider with positive rejection evidence may produce this state. */
  overlayAction: 'rollback'
  terminal: TxTerminalReason & { code: 'TX_REJECTED' }
}

interface TxExpiredStatus {
  status: 'expired'
  seen: false
  confirmations: 0
  /** Only a provider that can prove the signed validity interval elapsed may produce this state. */
  overlayAction: 'rollback'
  terminal: TxTerminalReason & { code: 'TX_EXPIRED' }
}

/**
 * Provider-neutral lifecycle for a submitted transaction.
 *
 * Absence is never rejection. A provider must return `unknown` unless it has positive evidence
 * for one of the other states; clients retain their pending overlay for both inconclusive states.
 */
export type TxStatus = TxInconclusiveStatus | TxConfirmedStatus | TxRejectedStatus | TxExpiredStatus

/** Canonical unknown status. */
export function unknownTxStatus(): TxStatus {
  return { status: 'unknown', seen: false, confirmations: 0, overlayAction: 'retain' }
}

/** Canonical mempool-pending status. */
export function pendingTxStatus(): TxStatus {
  return { status: 'pending', seen: false, confirmations: 0, overlayAction: 'retain' }
}

/** Canonical confirmed status. */
export function confirmedTxStatus(confirmations: number): TxStatus {
  if (!Number.isSafeInteger(confirmations) || confirmations < 0) {
    throw new RangeError('transaction confirmations must be a non-negative safe integer')
  }
  return { status: 'confirmed', seen: true, confirmations, overlayAction: 'reconcile' }
}

/** Canonical, sanitized terminal rejection. */
export function rejectedTxStatus(): TxStatus {
  return {
    status: 'rejected',
    seen: false,
    confirmations: 0,
    overlayAction: 'rollback',
    terminal: {
      code: 'TX_REJECTED',
      reason: 'The transaction was definitively rejected.',
    },
  }
}

/** Canonical, sanitized validity-interval expiry. */
export function expiredTxStatus(): TxStatus {
  return {
    status: 'expired',
    seen: false,
    confirmations: 0,
    overlayAction: 'rollback',
    terminal: {
      code: 'TX_EXPIRED',
      reason: 'The transaction validity interval expired before confirmation.',
    },
  }
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
