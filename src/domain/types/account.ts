/** Stake-account domain shapes. */

/** Stake-account level state: balance, rewards, and current delegations. */
export interface AccountState {
  /** Bech32 stake address. */
  stakeAddress: string
  /** Whether the stake key is registered on chain. */
  registered: boolean
  /** Total controlled lovelace (UTxO plus withdrawable rewards), as a string. */
  balance: string
  /** Rewards available to withdraw right now, as a string. */
  rewardsAvailable: string
  /** Lifetime rewards ever earned by the account (withdrawn plus available), as a string. */
  rewardsSum: string
  /** Lifetime rewards ever withdrawn from the account, as a string. */
  withdrawalsSum: string
  /** Pool the account currently delegates to (bech32), if any. */
  delegatedPool?: string
  /** DRep the account currently delegates its vote to, if any. */
  delegatedDrep?: string
}
