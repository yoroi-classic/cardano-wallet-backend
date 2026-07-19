import type {
  DrepInfo,
  DrepListParams,
  Proposal,
  ProposalListParams,
} from '../../domain/types/governance.js'
import type { GovernanceCapability } from '../capabilities/governance.js'
import { notImplemented } from './not-implemented.js'

/**
 * Governance reads are not part of this driver's first pass.
 *
 * Blockfrost has `/governance/dreps` and `/governance/proposals`, but reproducing the Koios
 * driver's normalization (registered-vs-not-registered DRep status, the four-epoch proposal
 * status precedence, best-effort off-chain metadata) is a capability area of its own, out of
 * scope for the six-endpoint proof of viability this PR ships. See issue #4's status comment.
 */
export function createGovernanceMethods(): GovernanceCapability {
  return {
    // async so notImplemented()'s synchronous throw becomes a rejected promise rather than
    // escaping the call before a caller's `await` sees it. See the note in assets.ts.
    async getDrepInfo(_drepIds: string[]): Promise<DrepInfo[]> {
      return notImplemented('getDrepInfo')
    },

    async getDrepList(_params: DrepListParams): Promise<DrepInfo[]> {
      return notImplemented('getDrepList')
    },

    async getProposals(_params: ProposalListParams): Promise<Proposal[]> {
      return notImplemented('getProposals')
    },
  }
}
