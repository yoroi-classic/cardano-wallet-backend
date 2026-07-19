/** Governance domain shapes: delegate representatives (DReps). */

/**
 * Registration lifecycle of a DRep. Normalized like `PoolStatus`, so the contract does not
 * hand clients a provider's own vocabulary.
 */
export type DrepStatus = 'registered' | 'deregistered' | 'not_registered'

/**
 * Normalized info for a delegate representative (DRep). Off-chain metadata (CIP-119) is
 * resolved best-effort into `name`/`image`; `metadataUrl`/`metadataHash` still point at the
 * raw source. Lovelace values are strings.
 */
export interface DrepInfo {
  /**
   * Bech32 DRep id, always in the CIP-129 form (`drep1...`, a 1-byte header plus the
   * credential), which is the current standard. The deprecated CIP-105 form is still
   * accepted on requests, but it is not what gets emitted here.
   */
  drepId: string
  /** The DRep's 28-byte credential, as hex. Identical across both id encodings. */
  hex: string
  /** Whether the DRep credential is a script. */
  hasScript: boolean
  /** Registration lifecycle. */
  status: DrepStatus
  /** Whether the DRep is currently active (not expired). */
  active: boolean
  /** Registration deposit, in lovelace. */
  deposit: string
  /** Voting power: total lovelace delegated to this DRep. */
  votingPower: string
  /** Epoch the DRep's registration expires in, if set. */
  expiresEpoch?: number
  /** URL of the DRep's off-chain (CIP-119) metadata, if any. */
  metadataUrl?: string
  /** Hash of the DRep's off-chain metadata, if any. */
  metadataHash?: string
  /** Display name from off-chain metadata (CIP-119 givenName), resolved best-effort. */
  name?: string
  /** Image pointer (URL/URI) from off-chain metadata. Not image bytes. */
  image?: string
}

/** Query for a page of the DRep list. */
export interface DrepListParams {
  /** Maximum DReps to return. */
  limit: number
  /** How many DReps to skip, for paging. */
  offset: number
}

/**
 * The seven kinds of governance action Conway defines. Koios's own vocabulary, constrained rather
 * than passed through, so an unexpected value is malformed upstream data and not a new action type
 * silently leaking into our contract.
 */
export const PROPOSAL_TYPES = [
  'ParameterChange',
  'HardForkInitiation',
  'TreasuryWithdrawals',
  'NoConfidence',
  'NewCommittee',
  'NewConstitution',
  'InfoAction',
] as const
export type ProposalType = (typeof PROPOSAL_TYPES)[number]

/**
 * Where a proposal has got to.
 *
 * Derived here rather than left to the client, because the raw data expresses it as four separate
 * nullable epoch fields (`ratified`, `enacted`, `dropped`, `expired`) and every client would
 * otherwise reimplement the same precedence rules, subtly differently. `enacted` beats `ratified`,
 * because a proposal is ratified first and enacted after.
 */
export type ProposalStatus = 'open' | 'ratified' | 'enacted' | 'dropped' | 'expired'

/** How a body of voters split on a proposal. Voting power is lovelace, as a string. */
export interface VoteTally {
  /** Votes cast, by count. */
  yes: number
  no: number
  abstain: number
  /** Voting power behind each, in lovelace. This, not the count, is what decides the outcome. */
  yesPower: string
  noPower: string
  abstainPower: string
}

/** A Conway governance action. */
export interface Proposal {
  /** Bech32 governance action id (`gov_action1...`). */
  proposalId: string
  /** The transaction that submitted it, and the action's index within it. */
  txHash: string
  index: number
  type: ProposalType
  status: ProposalStatus
  /**
   * The epoch it was proposed in, and the one it expires in if nothing happens.
   *
   * `proposedEpoch` is optional because not every provider can source it. Koios reports it
   * directly; Blockfrost exposes no proposed epoch and only the current `gov_action_lifetime`
   * parameter, which cannot be used to derive a historical proposal's epoch (the parameter can
   * change between the proposal and now). Rather than fabricate a value from the wrong-era
   * parameter, a provider that cannot source it leaves it absent.
   */
  proposedEpoch?: number
  expiryEpoch?: number
  /** Whichever of ratified/enacted/dropped/expired actually happened, if any. */
  decidedEpoch?: number
  /** Registration deposit, in lovelace. */
  deposit: string
  /** Where the deposit is returned to. */
  returnAddress: string

  /** CIP-108 off-chain metadata, resolved best-effort. */
  title?: string
  abstract?: string
  metadataUrl?: string
  metadataHash?: string
  /**
   * Whether the off-chain metadata's hash matched what was anchored on chain.
   *
   * A proposal's title and abstract are attacker-supplied text that a user reads before voting, so
   * a client must be able to tell a verified document from an unverified one. Absent means the
   * data source did not say.
   */
  metadataValid?: boolean

  /** How the DReps have voted so far. */
  drepVotes?: VoteTally
  /** How the stake pool operators have voted so far. */
  poolVotes?: VoteTally
  /** How the constitutional committee has voted so far. */
  committeeVotes?: VoteTally
}

/** Query for a page of the proposal list. */
export interface ProposalListParams {
  limit: number
  offset: number
}
