import type {
  AccountState,
  PoolInfo,
  PoolListParams,
  ProtocolParams,
  Tip,
  TokenMetadata,
  TxStatus,
  Utxo,
  WalletTransaction,
} from '../domain/types.js'

/**
 * The provider contract. Every data source (Koios, Blockfrost, a bring-your-own
 * Dingo node) implements this so the HTTP layer never has to know which one is
 * serving a request. It covers the barebones surface a wallet needs: chain tip and
 * protocol parameters, account state, UTxOs, transaction history, stake-pool info, plus
 * transaction submission and status. The interface grows one capability at a time as
 * endpoints land.
 */
export interface ChainProvider {
  /** A short name for logs and diagnostics, e.g. "koios". */
  readonly name: string

  /** Current chain tip. */
  getTip(): Promise<Tip>

  /** Protocol parameters for the latest epoch. */
  getProtocolParams(): Promise<ProtocolParams>

  /**
   * Of the given addresses, which have appeared on chain (been used). Returns the used
   * subset preserving the input order; addresses never seen on chain are omitted. The
   * result is a filter of the input, so it is never longer than `addresses`.
   */
  filterUsedAddresses(addresses: string[]): Promise<string[]>

  /** Stake-account state: balance, rewards, and current delegations. */
  getAccountState(stakeAddress: string): Promise<AccountState>

  /** All UTxOs controlled by a stake account, in one call. */
  getAccountUtxos(stakeAddress: string): Promise<Utxo[]>

  /**
   * Transaction history for a stake account, oldest first. `afterBlock` pages forward:
   * pass the block height of the last transaction already seen to get the next page.
   */
  getTxHistory(stakeAddress: string, afterBlock?: number): Promise<WalletTransaction[]>

  /**
   * Information for a batch of stake pools, by bech32 pool id. Returns one entry per pool
   * the source knows about, in the input order; unknown pool ids are omitted, so the
   * result is never longer than `poolIds`.
   */
  getPoolInfo(poolIds: string[]): Promise<PoolInfo[]>

  /**
   * A neutrally-ordered page of registered stake pools (largest active stake first, no
   * promotional ranking), each with full pool info. `ticker` optionally filters by ticker
   * (case-insensitive substring).
   */
  getPoolList(params: PoolListParams): Promise<PoolInfo[]>

  /**
   * Metadata for a batch of native tokens, by CIP-26 subject (policy id + hex asset name).
   * Returns one entry per token the source knows about, in the input order; unknown
   * subjects are omitted, so the result is never longer than `subjects`.
   */
  getTokenMetadata(subjects: string[]): Promise<TokenMetadata[]>

  /** Submit a serialized (CBOR hex) signed transaction. Returns the transaction hash. */
  submitTx(cborHex: string): Promise<{ txHash: string }>

  /** Confirmation status for a submitted transaction. */
  getTxStatus(txHash: string): Promise<TxStatus>
}
