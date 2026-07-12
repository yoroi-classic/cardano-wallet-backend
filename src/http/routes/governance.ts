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
const listQuery = z.object({
  limit: boundedInt(1, 250, 50),
  offset: boundedInt(0, 100_000, 0),
})

/** Governance reads (DReps). */
export function registerGovernanceRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.get('/v1/governance/dreps', async (request) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) {
      throw new BadRequestError('query must be limit (1-250) and offset (0-100000)')
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
}
