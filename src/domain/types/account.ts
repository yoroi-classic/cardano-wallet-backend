/** Stake-account domain shapes. */

/** Stake-account level state: balance, rewards, and current delegations. */
export interface AccountState {
  /** Bech32 stake address. */
  stakeAddress: string
  /** Whether the stake key is registered on chain. */
  registered: boolean
  /**
   * Total controlled lovelace (UTxO plus withdrawable rewards), as a string.
   *
   * Can be negative. The upstream sum excludes a pending governance proposal refund, so an
   * account with a deposit outstanding reports less than nothing until that deposit returns.
   */
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
 * `treasury` and `reserves` are MIR payouts. `refund` is a returned stake-key deposit and
 * `proposal_refund` a returned governance proposal deposit; they are kept apart because they say
 * different things about where the money came from, and a client showing a reward history should
 * not report a governance refund as a staking one. None of those four come from a pool, which is
 * why `poolId` is optional.
 *
 * `proposal_refund` is not in Koios's published enum, which is why it is worth naming here: the
 * live API returns it and the specification does not list it.
 */
export const REWARD_KINDS = [
  'member',
  'leader',
  'treasury',
  'reserves',
  'refund',
  'proposal_refund',
] as const
export type RewardKind = (typeof REWARD_KINDS)[number]

/** One reward, as it appears in an account's history. */
export interface AccountReward {
  /**
   * The epoch the reward was *earned for*, which is the one to plot it against.
   *
   * Not the same as the epoch it could be spent in: a pool reward is paid two epochs in arrears,
   * and other kinds are not. Both are here because a rewards graph wants the first and a balance
   * projection wants the second, and quietly picking one would make the other wrong by ten days.
   */
  earnedEpoch: number
  /**
   * The epoch the reward became withdrawable.
   *
   * The gap depends on the kind, so a client must not compute it from `earnedEpoch`. Pool rewards
   * (`member` and `leader`) are paid two epochs in arrears. A `proposal_refund` or a `treasury`
   * payout arrives the epoch after the one it is earned for.
   *
   * Koios reports this field and the value is carried through unchanged. Blockfrost reports only
   * the earned epoch, so its driver adds two, which is correct for every kind Blockfrost returns
   * (`member`, `leader` and a pool deposit refund) and is the reason that derivation is safe there
   * and would not be here.
   */
  spendableEpoch: number
  /** Lovelace, as a string. */
  amount: string
  kind: RewardKind
  /** The pool that paid it. Absent for treasury, reserves, and both refund kinds, which have no pool. */
  poolId?: string
}
