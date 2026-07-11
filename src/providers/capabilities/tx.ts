import type { TxStatus } from '../../domain/types/transactions.js'

/** Transaction submission and status. */
export interface TxCapability {
  /** Submit a serialized (CBOR hex) signed transaction. Returns the transaction hash. */
  submitTx(cborHex: string): Promise<{ txHash: string }>

  /** Confirmation status for a submitted transaction. */
  getTxStatus(txHash: string): Promise<TxStatus>
}
