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

/**
 * How a reward arose. Koios's own vocabulary, normalized.
 *
 * `member` is the ordinary case: the account delegated to a pool and got its share. `leader` is
 * the pool operator's own cut, and an account can receive both in the same epoch for the same
 * pool, which is why the history is a list and not a map keyed by epoch.
 *
 * `treasury` and `reserves` are MIR payouts, `refund` is a returned deposit. None of those three
 * come from a pool, which is why `poolId` is optional.
 */
export const REWARD_KINDS = ['member', 'leader', 'treasury', 'reserves', 'refund'] as const
export type RewardKind = (typeof REWARD_KINDS)[number]

/** One reward, as it appears in an account's history. */
export interface AccountReward {
  /**
   * The epoch the reward was *earned for*, which is the one to plot it against.
   *
   * Not the same as the epoch it could be spent in: Cardano pays rewards two epochs in arrears.
   * Both are here because a rewards graph wants the first and a balance projection wants the
   * second, and quietly picking one would make the other wrong by ten days.
   */
  earnedEpoch: number
  /** The epoch the reward became withdrawable. Always `earnedEpoch + 2` on today's protocol. */
  spendableEpoch: number
  /** Lovelace, as a string. */
  amount: string
  kind: RewardKind
  /** The pool that paid it. Absent for treasury, reserves, and refunds, which have no pool. */
  poolId?: string
}
