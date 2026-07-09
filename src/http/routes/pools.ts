import type { FastifyInstance } from 'fastify'
import { bech32 } from '@scure/base'
import { z } from 'zod'
import { BadRequestError } from '../../domain/errors.js'
import type { ChainProvider } from '../../providers/provider.js'

// Pool info is heavier than a plain address check, so cap the batch more tightly. The
// wallet requests pools in small groups (a delegated pool, or a page of the pool list).
const body = z.object({ poolIds: z.array(z.string().min(1)).min(1).max(100) })

const BECH32_LIMIT = 1023
// A pool id is a Blake2b-224 key hash: 28 bytes.
const POOL_KEY_HASH_BYTES = 28

// Validate a bech32 pool id (charset, checksum, `pool` HRP, and a 28-byte key hash) so a
// malformed value is rejected here rather than passed on to the provider. Checking the
// decoded length rejects a well-formed-but-wrong-size payload that still carries the HRP.
function isPoolId(value: string): boolean {
  const decoded = bech32.decodeUnsafe(value, BECH32_LIMIT)
  if (decoded === undefined || decoded.prefix !== 'pool') return false
  return bech32.fromWords(decoded.words).length === POOL_KEY_HASH_BYTES
}

/** Stake-pool reads. */
export function registerPoolRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.post('/v1/pools/info', async (request) => {
    const parsed = body.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError('body must be { "poolIds": [<pool id>, ...] } (1 to 100)')
    }
    if (!parsed.data.poolIds.every(isPoolId)) {
      throw new BadRequestError('poolIds must be bech32 pool ids (pool1...)')
    }
    return provider.getPoolInfo(parsed.data.poolIds)
  })
}
