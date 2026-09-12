import { bech32 } from '@scure/base'

/**
 * Parsing and validation for DRep identifiers.
 *
 * A DRep is identified on chain by a 28-byte credential (a Blake2b-224 hash of either a key
 * or a script). There are two bech32 encodings of it under the `drep` prefix:
 *
 * - CIP-129 (current): a 1-byte header followed by the credential, so 29 bytes. The header
 *   names the credential type: `0x22` for a key hash, `0x23` for a script hash.
 * - CIP-105 (deprecated): the bare 28-byte credential, with no header.
 *
 * CIP-129 is the form to emit and prefer. CIP-105 is deprecated but still in circulation
 * and still accepted upstream, so it is accepted on the way in rather than rejected.
 *
 * This lives in one place because the boundary (which rejects malformed ids) and the
 * provider (which matches upstream rows back to the id the caller asked for) have to agree
 * on exactly what a DRep id is. If they drifted, an id could validate at the edge and then
 * fail to match its own row, and the DRep would silently disappear from the response.
 */

/** The Blake2b-224 credential a DRep id carries: 28 bytes. */
export const DREP_CREDENTIAL_BYTES = 28

/** A CIP-129 DRep id is the credential prefixed with a 1-byte header. */
export const CIP129_DREP_BYTES = DREP_CREDENTIAL_BYTES + 1

/** CIP-129 header for a DRep whose credential is a key hash. */
export const CIP129_DREP_KEY_HEADER = 0x22

/** CIP-129 header for a DRep whose credential is a script hash. */
export const CIP129_DREP_SCRIPT_HEADER = 0x23

const BECH32_LIMIT = 1023

/**
 * Decode a bech32 DRep id and return its 28-byte credential as lowercase hex, or
 * `undefined` if the value is not a well-formed DRep id.
 *
 * Every step is non-throwing. A good checksum does not mean the 5-bit payload converts back
 * to bytes, and letting the throwing converter escape would turn bad caller input into a
 * 500 instead of the 400 it deserves.
 */
export function drepCredentialHex(value: string): string | undefined {
  const decoded = bech32.decodeUnsafe(value, BECH32_LIMIT)
  if (decoded === undefined || decoded.prefix !== 'drep') return undefined

  const bytes = bech32.fromWordsUnsafe(decoded.words)
  if (bytes === undefined) return undefined

  if (bytes.length === CIP129_DREP_BYTES) {
    const header = bytes[0]
    if (header !== CIP129_DREP_KEY_HEADER && header !== CIP129_DREP_SCRIPT_HEADER) {
      return undefined
    }
    return toHex(bytes.slice(1))
  }

  // Deprecated CIP-105: the bare credential, no header byte.
  if (bytes.length === DREP_CREDENTIAL_BYTES) return toHex(bytes)

  return undefined
}

/** Whether a value is a well-formed DRep id (CIP-129, or deprecated CIP-105). */
export function isDrepId(value: string): boolean {
  return drepCredentialHex(value) !== undefined
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex').toLowerCase()
}
