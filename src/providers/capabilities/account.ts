import type { AccountReward, AccountState } from '../../domain/types/account.js'
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

  /**
   * Every reward the account has earned, oldest first.
   *
   * The whole history, not a running total, because the total is what `getAccountState` already
   * gives you as `rewardsSum`. What a rewards graph needs, and what a total cannot reconstruct,
   * is the shape.
   *
   * `afterEpoch` pages forward on the epoch the reward was *earned* for.
   */
  getRewardHistory(stakeAddress: string, afterEpoch?: number): Promise<AccountReward[]>
}
