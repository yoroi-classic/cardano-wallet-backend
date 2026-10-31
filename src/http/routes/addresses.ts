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
const CREDENTIAL_BYTES = 28
const BASE_ADDRESS_BYTES = 1 + CREDENTIAL_BYTES * 2
const ENTERPRISE_ADDRESS_BYTES = 1 + CREDENTIAL_BYTES
const POINTER_PREFIX_BYTES = 1 + CREDENTIAL_BYTES
const MAX_POINTER_UINT_BYTES = 10

const PAYMENT_ADDRESS_ERROR =
  'addresses must be valid payment addresses (bech32 addr / addr_test, or Byron base58)'
const FILTER_USED_ERROR =
  'addresses must be valid payment addresses or bech32 payment key hashes (addr_vkh)'

function configuredNetworkId(network: string): number | undefined {
  if (network === 'mainnet') return 1
  if (network === 'preprod' || network === 'preview') return 0
  return undefined
}

/**
 * Consume one minimally encoded base-128 natural number from a pointer address.
 *
 * Pointer addresses carry slot, transaction index and certificate index this way. Ten groups
 * are enough for an unsigned 64-bit value; the first group of a ten-byte value can contain only
 * one payload bit. Rejecting redundant leading zero groups keeps this to the ledger encoding
 * rather than merely finding any three terminating bytes.
 */
function nextPointerPart(bytes: Uint8Array, offset: number): number | undefined {
  for (let index = offset; index < bytes.length; index += 1) {
    const byte = bytes[index]!
    const length = index - offset + 1
    if (length > MAX_POINTER_UINT_BYTES) return undefined
    if (length === 1 && (byte & 0x80) !== 0 && (byte & 0x7f) === 0) return undefined
    if (length === MAX_POINTER_UINT_BYTES && (bytes[offset]! & 0x7f) > 1) return undefined
    if ((byte & 0x80) === 0) return index + 1
  }
  return undefined
}

function hasPointerPayload(bytes: Uint8Array): boolean {
  let offset = POINTER_PREFIX_BYTES
  for (let part = 0; part < 3; part += 1) {
    const next = nextPointerPart(bytes, offset)
    if (next === undefined) return false
    offset = next
  }
  return offset === bytes.length
}

function isBech32PaymentAddress(value: string, expectedNetworkId?: number): boolean {
  const decoded = bech32.decodeUnsafe(value, BECH32_LIMIT)
  if (decoded === undefined) return false
  const bytes = bech32.fromWordsUnsafe(decoded.words)
  if (bytes === undefined || bytes.length === 0) return false

  const type = bytes[0]! >> 4
  const networkId = bytes[0]! & 0x0f
  // This service supports Cardano mainnet and the public test networks only.
  if (networkId !== 0 && networkId !== 1) return false
  if (decoded.prefix !== (networkId === 1 ? 'addr' : 'addr_test')) return false
  if (expectedNetworkId !== undefined && networkId !== expectedNetworkId) return false

  if (type <= 3) return bytes.length === BASE_ADDRESS_BYTES
  if (type <= 5) return bytes.length > POINTER_PREFIX_BYTES && hasPointerPayload(bytes)
  if (type <= 7) return bytes.length === ENTERPRISE_ADDRESS_BYTES
  return false
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
function isPaymentAddress(value: string, expectedNetworkId?: number): boolean {
  return isBech32PaymentAddress(value, expectedNetworkId) || isByronAddress(value)
}

function paymentCredentialHex(value: string): string | undefined {
  const decoded = bech32.decodeUnsafe(value, BECH32_LIMIT)
  if (decoded === undefined || decoded.prefix !== 'addr_vkh') return undefined
  const bytes = bech32.fromWordsUnsafe(decoded.words)
  if (bytes === undefined || bytes.length !== 28) return undefined
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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
export function registerAddressRoutes(
  app: FastifyInstance,
  provider: ChainProvider,
  network = 'unknown',
): void {
  const expectedNetworkId = configuredNetworkId(network)
  app.post('/v1/addresses/filter-used', async (request) => {
    const parsed = addressesBody.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError('body must be { "addresses": [<address>, ...] } (1 to 1000)')
    }
    const inputs = distinct(parsed.data.addresses)
    const credentials = new Map<string, string>()
    const paymentAddresses: string[] = []
    for (const input of inputs) {
      const credential = paymentCredentialHex(input)
      if (credential !== undefined) credentials.set(input, credential)
      else if (isPaymentAddress(input, expectedNetworkId)) paymentAddresses.push(input)
      else throw new BadRequestError(FILTER_USED_ERROR)
    }

    const [usedAddresses, usedCredentials] = await Promise.all([
      paymentAddresses.length === 0
        ? Promise.resolve([])
        : provider.filterUsedAddresses(paymentAddresses),
      credentials.size === 0
        ? Promise.resolve([])
        : provider.filterUsedPaymentCredentials([...credentials.values()]),
    ])
    const addressSet = new Set(usedAddresses)
    const credentialSet = new Set(usedCredentials)
    return inputs.filter((input) => {
      const credential = credentials.get(input)
      return credential === undefined ? addressSet.has(input) : credentialSet.has(credential)
    })
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
    if (!parsed.data.addresses.every((address) => isPaymentAddress(address, expectedNetworkId))) {
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
    if (!parsed.data.addresses.every((address) => isPaymentAddress(address, expectedNetworkId))) {
      throw new BadRequestError(PAYMENT_ADDRESS_ERROR)
    }
    return provider.getTxHistoryByAddresses(distinct(parsed.data.addresses), parsed.data.after)
  })
}
