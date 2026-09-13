import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { BadRequestError } from '../../domain/errors.js'
import { isDrepId } from '../../domain/drep.js'
import type { ChainProvider } from '../../providers/provider.js'

const body = z.object({ drepIds: z.array(z.string().min(1)).min(1).max(100) })

// A query param arrives as a string. `z.coerce.number()` would put it through JS `Number()`,
// which accepts a great deal more than a page bound should: '' and '   ' become 0, '1e3'
// becomes 1000, and '0x10' becomes 16. Demand digits first and convert after, so anything
// else stays a string and is rejected as the 400 it is.
const boundedInt = (min: number, max: number, fallback: number) =>
  z.preprocess(
    (v) => (v === undefined ? fallback : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v),
    z.number().int().min(min).max(max),
  )

// A page hydrates each DRep with full info, so cap the size.
//
// The offset ceiling leaves room for a full page beneath the provider's scan bound, because
// what the provider has to reach is offset + limit, not offset. An offset of exactly the scan
// bound with the largest limit would ask for row 20,250 of a 20,000-row scan and fail. The API
// must not advertise a page it cannot serve. There are ~1.7k registered
// DReps, so this is already far past the end of any real list, where the answer is an empty
// page rather than an error.
const PROVIDER_SCAN_BOUND = 20_000
const MAX_LIMIT = 250
const MAX_OFFSET = PROVIDER_SCAN_BOUND - MAX_LIMIT

// A page of proposals hydrates each one with its vote tally, which is a call per proposal, so the
// page is capped well below the DRep list's. There are a few hundred governance actions in total,
// not thousands, so the offset ceiling is generous relative to the data rather than to the scan.
const MAX_PROPOSAL_LIMIT = 50
const MAX_PROPOSAL_OFFSET = 10_000

const proposalQuery = z.object({
  limit: boundedInt(1, MAX_PROPOSAL_LIMIT, 20),
  offset: boundedInt(0, MAX_PROPOSAL_OFFSET, 0),
})

const listQuery = z.object({
  limit: boundedInt(1, MAX_LIMIT, 50),
  offset: boundedInt(0, MAX_OFFSET, 0),
})

/** Governance reads (DReps). */
export function registerGovernanceRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.get('/v1/governance/dreps', async (request) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) {
      throw new BadRequestError(`query must be limit (1-${MAX_LIMIT}) and offset (0-${MAX_OFFSET})`)
    }
    return provider.getDrepList(parsed.data)
  })

  app.post('/v1/governance/dreps/info', async (request) => {
    const parsed = body.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError('body must be { "drepIds": [<drep id>, ...] } (1 to 100)')
    }
    if (!parsed.data.drepIds.every(isDrepId)) {
      throw new BadRequestError(
        'drepIds must be bech32 DRep ids: CIP-129 (drep1...), or the deprecated CIP-105 form',
      )
    }
    return provider.getDrepInfo(parsed.data.drepIds)
  })

  /**
   * Conway governance actions, newest first.
   *
   * With the vote tallies as they stand, because a proposal without them is not something a user
   * can act on: "should I vote on this?" is answered by where the vote currently sits, not by the
   * text alone.
   *
   * `status` is derived here rather than left to the client: upstream expresses a proposal's fate
   * as four separate nullable epoch fields, and every client would otherwise reimplement the same
   * precedence rules, subtly differently.
   */
  app.get('/v1/governance/proposals', async (request) => {
    const parsed = proposalQuery.safeParse(request.query)
    if (!parsed.success) {
      throw new BadRequestError(
        `query must be limit (1-${MAX_PROPOSAL_LIMIT}) and offset (0-${MAX_PROPOSAL_OFFSET})`,
      )
    }
    return provider.getProposals(parsed.data)
  })
}
