import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { BadRequestError } from '../../domain/errors.js'
import { MAX_SUBJECT_HEX_LEN, POLICY_ID_HEX_LEN } from '../../domain/constants.js'
import type { ChainProvider } from '../../providers/provider.js'

// A wallet asks about the tokens it holds in one call; cap the batch so upstream stays
// bounded. The length cap on each entry keeps an oversized string from reaching the hex
// scan below at all.
const body = z.object({
  subjects: z.array(z.string().min(1).max(MAX_SUBJECT_HEX_LEN)).min(1).max(100),
})

// Validate a CIP-26 subject: hex, even length, and within the policy-id / asset-name bounds,
// so a malformed value is rejected here rather than passed on to the provider.
//
// The length bounds are checked before the character scan: they are O(1) where the regex is
// O(n), so a junk subject is rejected without walking it.
function isSubject(value: string): boolean {
  return (
    value.length >= POLICY_ID_HEX_LEN &&
    value.length <= MAX_SUBJECT_HEX_LEN &&
    value.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(value)
  )
}

/** Native-token (asset) reads. */
export function registerAssetRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.post('/v1/assets/info', async (request) => {
    const parsed = body.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError(
        'body must be { "subjects": [<policyId+assetNameHex>, ...] } (1 to 100)',
      )
    }
    if (!parsed.data.subjects.every(isSubject)) {
      throw new BadRequestError(
        'each subject must be a hex policy id (28 bytes) optionally followed by a hex asset name (up to 32 bytes)',
      )
    }
    return provider.getTokenMetadata(parsed.data.subjects)
  })
}
