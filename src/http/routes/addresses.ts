import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { BadRequestError } from '../../domain/errors.js'
import type { ChainProvider } from '../../providers/provider.js'

// A wallet asks about a batch of derived addresses at once; cap it to keep upstream
// requests bounded.
const body = z.object({ addresses: z.array(z.string().min(1)).min(1).max(1000) })

/** Address-level reads. */
export function registerAddressRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.post('/v1/addresses/filter-used', async (request) => {
    const parsed = body.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError('body must be { "addresses": [<address>, ...] } (1 to 1000)')
    }
    return provider.filterUsedAddresses(parsed.data.addresses)
  })
}
