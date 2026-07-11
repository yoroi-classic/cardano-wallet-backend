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
//
// Every step has to be non-throwing: the checksum passing does not mean the 5-bit payload
// converts back to bytes, and the throwing `fromWords` would surface that as a 500 rather
// than the 400 this bad input deserves.
function isPoolId(value: string): boolean {
  const decoded = bech32.decodeUnsafe(value, BECH32_LIMIT)
  if (decoded === undefined || decoded.prefix !== 'pool') return false
  const bytes = bech32.fromWordsUnsafe(decoded.words)
  return bytes !== undefined && bytes.length === POOL_KEY_HASH_BYTES
}

// Page bounds for the list. A page hydrates each pool with full info, so cap the size.
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  // Restricted to an alphanumeric substring so it can't smuggle PostgREST filter syntax
  // into the upstream query.
  ticker: z
    .string()
    .regex(/^[A-Za-z0-9]{1,15}$/)
    .optional(),
})

/** Stake-pool reads. */
export function registerPoolRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.get('/v1/pools', async (request) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) {
      throw new BadRequestError(
        'query must be limit (1-250), offset (>=0), and an optional alphanumeric ticker',
      )
    }
    return provider.getPoolList(parsed.data)
  })

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
