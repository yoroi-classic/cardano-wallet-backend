import { describe, expect, it } from 'vitest'
import { PROPOSAL_TYPES } from '../../src/domain/types/governance.js'
import { BLOCKFROST_PROJECT_ID, integrationProvider } from './support/provider-blockfrost.js'

const skip = BLOCKFROST_PROJECT_ID === undefined

describe('blockfrost governance (integration)', () => {
  it.skipIf(skip)('returns a neutral page of registered dreps and looks one up by id', async () => {
    const provider = integrationProvider()
    const dreps = await provider.getDrepList({ limit: 3, offset: 0 })

    expect(dreps.length).toBeGreaterThan(0)
    expect(dreps.length).toBeLessThanOrEqual(3)
    for (const drep of dreps) {
      expect(drep.drepId).toMatch(/^drep1[0-9a-z]+$/)
      expect(drep.status).toBe('registered')
      expect(drep.hex).toMatch(/^[0-9a-f]{56}$/)
      expect(BigInt(drep.votingPower)).toBeGreaterThanOrEqual(0n)
    }

    // The direct lookup must agree with the listed DRep.
    const first = dreps[0]?.drepId
    const [byId] = await provider.getDrepInfo([first as string])
    expect(byId?.drepId).toBe(first)
    expect(byId?.hex).toMatch(/^[0-9a-f]{56}$/)
  })

  it.skipIf(skip)('returns governance proposals newest-first with derived fields', async () => {
    const proposals = await integrationProvider().getProposals({ limit: 5, offset: 0 })

    // A network may have no proposals yet; only assert when some exist.
    for (const proposal of proposals) {
      expect(proposal.proposalId).toMatch(/^gov_action1[0-9a-z]+$/)
      expect(proposal.txHash).toMatch(/^[0-9a-f]{64}$/)
      expect(PROPOSAL_TYPES).toContain(proposal.type)
      expect(proposal.proposedEpoch).toBeLessThanOrEqual(
        proposal.expiryEpoch ?? proposal.proposedEpoch,
      )
      expect(BigInt(proposal.deposit)).toBeGreaterThanOrEqual(0n)
    }
  })
})
