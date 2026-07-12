import type { AccountState } from '../../domain/types/account.js'
import type { Utxo, WalletTransaction } from '../../domain/types/transactions.js'

/** Stake-account reads, all keyed by bech32 stake address. */
export interface AccountCapability {
  /** Stake-account state: balance, rewards, and current delegations. */
  getAccountState(stakeAddress: string): Promise<AccountState>

  /** All UTxOs controlled by a stake account, in one call. */
  getAccountUtxos(stakeAddress: string): Promise<Utxo[]>

  /**
   * Transaction history for a stake account, oldest first. `afterBlock` pages forward:
   * pass the block height of the last transaction already seen to get the next page.
   */
  getTxHistory(stakeAddress: string, afterBlock?: number): Promise<WalletTransaction[]>
}
