import type { AccountState, ProtocolParams, Tip, TxStatus, Utxo } from '../domain/types.js'

/**
 * The provider contract. Every data source (Koios, Blockfrost, a bring-your-own
 * Dingo node) implements this so the HTTP layer never has to know which one is
 * serving a request. It covers the barebones surface a wallet needs: chain tip and
 * protocol parameters, account state and UTxOs, and transaction submit and status.
 * The interface grows one capability at a time as endpoints land.
 */
export interface ChainProvider {
  /** A short name for logs and diagnostics, e.g. "koios". */
  readonly name: string

  /** Current chain tip. */
  getTip(): Promise<Tip>

  /** Protocol parameters for the latest epoch. */
  getProtocolParams(): Promise<ProtocolParams>

  /** Stake-account state: balance, rewards, and current delegations. */
  getAccountState(stakeAddress: string): Promise<AccountState>

  /** All UTxOs controlled by a stake account, in one call. */
  getAccountUtxos(stakeAddress: string): Promise<Utxo[]>

  /** Submit a serialized (CBOR hex) signed transaction. Returns the transaction hash. */
  submitTx(cborHex: string): Promise<{ txHash: string }>

  /** Confirmation status for a submitted transaction. */
  getTxStatus(txHash: string): Promise<TxStatus>
}
