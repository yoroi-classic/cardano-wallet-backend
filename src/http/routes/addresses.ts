import type { FastifyInstance } from 'fastify'
import { bech32 } from '@scure/base'
import { z } from 'zod'
import { isByronAddress } from '../../domain/byron-address.js'
import { BadRequestError } from '../../domain/errors.js'
import type { ChainProvider } from '../../providers/provider.js'

// A wallet asks about a batch of derived addresses at once; cap it to keep upstream
// requests bounded.
const addressesBody = z.object({ addresses: z.array(z.string().min(1)).min(1).max(1000) })
const addressesWithAfterBody = z.object({
  addresses: z.array(z.string().min(1)).min(1).max(1000),
  after: z.number().int().nonnegative().optional(),
})

const BECH32_LIMIT = 1023
const PAYMENT_PREFIXES = new Set(['addr', 'addr_test'])
// The top nibble of a Shelley address header is its type. Types 0-7 (base, pointer,
// enterprise) carry a spendable payment credential; 14/15 are stake/reward addresses and
// 8-13 are unused or Byron, none of which belong on this endpoint.
const PAYMENT_ADDRESS_MAX_TYPE = 7

const PAYMENT_ADDRESS_ERROR =
  'addresses must be valid payment addresses (bech32 addr / addr_test, or Byron base58)'

function isBech32PaymentAddress(value: string): boolean {
  const decoded = bech32.decodeUnsafe(value, BECH32_LIMIT)
  if (decoded === undefined || !PAYMENT_PREFIXES.has(decoded.prefix)) return false
  const header = bech32.fromWords(decoded.words)[0]
  return header !== undefined && header >> 4 <= PAYMENT_ADDRESS_MAX_TYPE
}

/**
 * Validate a payment address, in either encoding a wallet can produce: a bech32 Shelley
 * address (charset, checksum, addr/addr_test HRP, and a header that names a payment type),
 * or a base58 Byron address (base58 charset, real CBOR structure, matching CRC32). Byron
 * predates bech32 entirely and has no bech32 form, so this is a second, independent
 * structural check rather than a relaxation of the bech32 one: neither accepts what the
 * other rejects, and something that is neither still 400s.
 *
 * A batch mixing Byron and Shelley addresses is not rejected as a batch because of that.
 * Each address is checked independently under `.every()` below, so a genuinely valid Byron
 * address alongside genuinely valid Shelley addresses passes: the original bug was that
 * Byron was *unconditionally* rejected here, never that mixing kinds was disallowed. Only a
 * malformed address of either kind still fails the whole batch.
 */
function isPaymentAddress(value: string): boolean {
  return isBech32PaymentAddress(value) || isByronAddress(value)
}

/**
 * Collapse a batch to its distinct addresses, keeping first-seen order.
 *
 * A caller can repeat an address in the set, and the reads that follow answer per address across
 * more than one upstream request when the set is large enough to split. Left as-is, a repeated
 * address that lands in two different chunks brings its UTxOs back twice, so the endpoint would
 * return duplicates for a set it promised to answer once. Deduplicating here, at the boundary,
 * fixes it for every read below rather than in each one.
 */
function distinct(addresses: string[]): string[] {
  return [...new Set(addresses)]
}

/** Address-level reads: discovery, and reads keyed by an address set rather than a stake key. */
export function registerAddressRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.post('/v1/addresses/filter-used', async (request) => {
    const parsed = addressesBody.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError('body must be { "addresses": [<address>, ...] } (1 to 1000)')
    }
    if (!parsed.data.addresses.every(isPaymentAddress)) {
      throw new BadRequestError(PAYMENT_ADDRESS_ERROR)
    }
    return provider.filterUsedAddresses(distinct(parsed.data.addresses))
  })

  /**
   * Every UTxO controlled by any of the given addresses, in one call.
   *
   * For a wallet with no resolvable stake credential to read `/v1/account/{stake}/utxos`
   * with: Byron, enterprise, and pointer addresses are all on that side of the line. Accepts
   * the same address formats as filter-used, mixed freely.
   */
  app.post('/v1/addresses/utxos', async (request) => {
    const parsed = addressesBody.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError('body must be { "addresses": [<address>, ...] } (1 to 1000)')
    }
    if (!parsed.data.addresses.every(isPaymentAddress)) {
      throw new BadRequestError(PAYMENT_ADDRESS_ERROR)
    }
    return provider.getUtxosByAddresses(distinct(parsed.data.addresses))
  })

  /**
   * Transaction history for a set of addresses, oldest first. The address-keyed sibling of
   * `/v1/account/{stake}/txs`, for the same wallets `/v1/addresses/utxos` serves. `after`
   * pages forward the same way: pass the `block` of the last transaction already seen.
   */
  app.post('/v1/addresses/txs', async (request) => {
    const parsed = addressesWithAfterBody.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError(
        'body must be { "addresses": [<address>, ...], "after"?: <block height> } ' +
          '(1 to 1000 addresses)',
      )
    }
    if (!parsed.data.addresses.every(isPaymentAddress)) {
      throw new BadRequestError(PAYMENT_ADDRESS_ERROR)
    }
    return provider.getTxHistoryByAddresses(distinct(parsed.data.addresses), parsed.data.after)
  })
}
