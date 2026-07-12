import type { DrepInfo, DrepListParams } from '../../domain/types/governance.js'

/** Governance reads (delegate representatives). */
export interface GovernanceCapability {
  /**
   * Info for a batch of DReps, by bech32 drep id. Returns one entry per DRep the source
   * knows about, in the input order; unknown ids are omitted.
   */
  getDrepInfo(drepIds: string[]): Promise<DrepInfo[]>

  /**
   * A page of registered DReps, in a neutral (unranked) order, each with full DRep info.
   */
  getDrepList(params: DrepListParams): Promise<DrepInfo[]>
}
