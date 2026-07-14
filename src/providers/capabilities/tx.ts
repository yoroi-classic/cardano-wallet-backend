import type { ResolvedUtxo, TxStatus } from '../../domain/types/transactions.js'

/** Transaction submission, status, and output lookups. */
export interface TxCapability {
  /** Submit a serialized (CBOR hex) signed transaction. Returns the transaction hash. */
  submitTx(cborHex: string): Promise<{ txHash: string }>

  /** Confirmation status for a submitted transaction. */
  getTxStatus(txHash: string): Promise<TxStatus>

  /**
   * Resolve transaction outputs by reference (`txHash#index`).
   *
   * A different question from `getAccountUtxos`, which asks "what does this wallet control" and
   * so only ever answers with unspent outputs. This asks "what is at this reference", and the
   * answer includes whether it is still there: a dApp connector resolving a transaction's inputs
   * needs to see them whether or not they survive, and a wallet re-checking a collateral input it
   * set aside an hour ago needs to learn that it has since been spent rather than building a
   * transaction the node will reject.
   *
   * References not on chain at all are simply absent from the result, so it can be shorter than
   * the request. Order follows the input.
   */
  getUtxosByRef(refs: string[]): Promise<ResolvedUtxo[]>
}
