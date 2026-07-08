import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { BadRequestError } from '../../domain/errors.js'
import type { ChainProvider } from '../../providers/provider.js'

// Even-length hex (whole bytes), matching what the provider will accept.
const submitBody = z.object({ cbor: z.string().regex(/^([0-9a-fA-F]{2})+$/) })
const TX_HASH = /^[0-9a-fA-F]{64}$/

/** Transaction submit and status. */
export function registerTxRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.post('/v1/tx/submit', async (request) => {
    const parsed = submitBody.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError('body must be { "cbor": "<hex-encoded transaction>" }')
    }
    return provider.submitTx(parsed.data.cbor)
  })

  app.get('/v1/tx/:hash/status', async (request) => {
    const { hash } = request.params as { hash: string }
    if (!TX_HASH.test(hash)) {
      throw new BadRequestError('invalid transaction hash')
    }
    return provider.getTxStatus(hash)
  })
}
