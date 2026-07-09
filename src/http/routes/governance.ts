import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { BadRequestError } from '../../domain/errors.js'
import { isDrepId } from '../../domain/drep.js'
import type { ChainProvider } from '../../providers/provider.js'

const body = z.object({ drepIds: z.array(z.string().min(1)).min(1).max(100) })

// A page hydrates each DRep with full info, so cap the size.
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})

/** Governance reads (DReps). */
export function registerGovernanceRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.get('/v1/governance/dreps', async (request) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) {
      throw new BadRequestError('query must be limit (1-250) and offset (>=0)')
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
