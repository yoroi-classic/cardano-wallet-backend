import type { FastifyInstance } from 'fastify'
import { bech32 } from '@scure/base'
import { z } from 'zod'
import { BadRequestError } from '../../domain/errors.js'
import type { ChainProvider } from '../../providers/provider.js'

// A wallet asks about a batch of derived addresses at once; cap it to keep upstream
// requests bounded.
const body = z.object({ addresses: z.array(z.string().min(1)).min(1).max(1000) })

const BECH32_LIMIT = 1023
const PAYMENT_PREFIXES = new Set(['addr', 'addr_test'])

// Validate a bech32 payment address (charset, checksum, addr/addr_test HRP) so a
// malformed value is rejected here rather than passed on to the provider.
function isPaymentAddress(value: string): boolean {
  const decoded = bech32.decodeUnsafe(value, BECH32_LIMIT)
  return decoded !== undefined && PAYMENT_PREFIXES.has(decoded.prefix)
}

/** Address-level reads. */
export function registerAddressRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.post('/v1/addresses/filter-used', async (request) => {
    const parsed = body.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError('body must be { "addresses": [<address>, ...] } (1 to 1000)')
    }
    if (!parsed.data.addresses.every(isPaymentAddress)) {
      throw new BadRequestError('addresses must be bech32 payment addresses (addr / addr_test)')
    }
    return provider.filterUsedAddresses(parsed.data.addresses)
  })
}
