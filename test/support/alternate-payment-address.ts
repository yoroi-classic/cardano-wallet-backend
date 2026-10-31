import { bech32 } from '@scure/base'

const BECH32_LIMIT = 1023
const PAYMENT_PREFIXES = new Set(['addr', 'addr_test'])
const PAYMENT_ADDRESS_MAX_TYPE = 7
const FIRST_PAYMENT_CREDENTIAL_BYTE = 1

/**
 * Build a checksum-valid address with the same Shelley shape, network, and delegation credential,
 * but a deterministically different payment credential.
 *
 * Integration discovery supplies a real used address. Changing a decoded credential byte before
 * re-encoding preserves the address header and recomputes Bech32's checksum; changing a character
 * in the encoded string would only corrupt that checksum and test malformed input instead.
 */
export function alternatePaymentAddress(address: string): string {
  const decoded = bech32.decodeUnsafe(address, BECH32_LIMIT)
  if (decoded === undefined || !PAYMENT_PREFIXES.has(decoded.prefix)) {
    throw new Error('expected a bech32 Shelley payment address')
  }
  const bytes = bech32.fromWordsUnsafe(decoded.words)
  const header = bytes?.[0]
  const credentialByte = bytes?.[FIRST_PAYMENT_CREDENTIAL_BYTE]
  if (
    bytes === undefined ||
    header === undefined ||
    credentialByte === undefined ||
    header >> 4 > PAYMENT_ADDRESS_MAX_TYPE
  ) {
    throw new Error('expected a bech32 Shelley payment address')
  }

  const alternate = Uint8Array.from(bytes)
  alternate[FIRST_PAYMENT_CREDENTIAL_BYTE] = credentialByte ^ 1
  return bech32.encode(decoded.prefix, bech32.toWords(alternate), BECH32_LIMIT)
}
