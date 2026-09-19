import type {
  DrepInfo,
  DrepListParams,
  Proposal,
  ProposalListParams,
} from '../../domain/types/governance.js'

/** Governance reads (delegate representatives). */
export interface GovernanceCapability {
  /**
   * Info for a batch of DReps, by bech32 drep id, in the input order.
   *
   * A DRep the source has never heard of is omitted. A DRep the source *does* know about but
   * which is not registered on chain comes back with `status: 'not_registered'` rather than
   * being dropped: "this id is well-formed and has never registered" is a different and more
   * useful answer than silence, which a caller cannot tell apart from a failed lookup. So the
   * result is never longer than `drepIds`, and callers must read `status` rather than treat
   * presence as proof of registration.
   *
   * `getDrepList` is the opposite: it promises registered DReps and filters accordingly.
   */
  getDrepInfo(drepIds: string[]): Promise<DrepInfo[]>

  /**
   * A page of registered DReps, in a neutral (unranked) order, each with full DRep info.
   *
   * Only DReps whose status is still `registered` at hydration time are returned, so a page
   * can be shorter than `limit` when one deregisters mid-request.
   */
  getDrepList(params: DrepListParams): Promise<DrepInfo[]>

  /**
   * Conway governance actions, newest first.
   *
   * Includes the vote tallies as they stand, because a proposal without them is not something a
   * user can act on: "should I vote?" is answered by where the vote currently sits, not by the
   * text alone.
   */
  getProposals(params: ProposalListParams): Promise<Proposal[]>
}
