/**
 * Structural validation for Byron (base58) addresses.
 *
 * A Byron address is base58 of a fixed CBOR shape (CIP-19's byron-addresses.cddl, matching
 * cardano-ledger's byron.cddl):
 *
 *   [ #6.24(bytes .cbor [addressRoot, addressAttributes, addressType]), crc32 ]
 *
 * a two-element array holding a CBOR tag-24 byte string (itself the CBOR encoding of the
 * address root, its attributes, and its type) and a CRC32 of that byte string's *content*.
 * Verifying the checksum over that fixed shape is real structural validation: it catches
 * truncation, a flipped bit, and base58 of unrelated data, without needing to recompute the
 * address root's blake2b/sha3 hash.
 *
 * There is no CBOR or CRC32 library in this project's dependencies on purpose (no
 * cardano-serialization-lib), so both are hand-rolled here, minimally: the CRC is the
 * standard IEEE 802.3 polynomial (the same one ZIP and PNG use), and the CBOR reader only
 * knows how to peel the exact shape above, not CBOR in general.
 */

import { base58 } from '@scure/base'

/** CRC-32/ISO-HDLC, bit by bit rather than table driven: a Byron address is a few dozen bytes,
 * so the table's setup cost buys nothing, and the bitwise form has no array indexing to guard
 * against `noUncheckedIndexedAccess`. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      // crc & 1 is 0 or 1; negating it gives 0 or -1, and -1 as a 32-bit int is all-ones, so
      // this masks the polynomial in or out without a branch.
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** One CBOR item's header: which major type it is, and the length/value the additional-info
 * bits (plus any following bytes) encode. Array count, tag number, byte-string length, and
 * unsigned integer value all share this same encoding, which is why one function reads all of
 * them. */
interface CborHeader {
  majorType: number
  value: number
  /** Bytes consumed by the header itself, not counting any content that follows it. */
  headerLength: number
}

function byteAt(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset]
  if (value === undefined) throw new Error('truncated CBOR item')
  return value
}

/**
 * Read one CBOR item header at `offset`. Definite-length only: Byron never emits an
 * indefinite-length item, and this reader has no shape to support besides the fixed one
 * `isByronAddress` peels below.
 */
function readCborHeader(bytes: Uint8Array, offset: number): CborHeader {
  const first = byteAt(bytes, offset)
  const majorType = first >> 5
  const info = first & 0x1f

  if (info < 24) return { majorType, value: info, headerLength: 1 }
  if (info === 24) return { majorType, value: byteAt(bytes, offset + 1), headerLength: 2 }
  if (info === 25) {
    const value = (byteAt(bytes, offset + 1) << 8) | byteAt(bytes, offset + 2)
    return { majorType, value, headerLength: 3 }
  }
  if (info === 26) {
    // The top byte is combined with `+` rather than `<<`/`|`: it alone can exceed 2^31, where
    // those operators would coerce through a signed 32-bit int and flip the sign.
    const value =
      byteAt(bytes, offset + 1) * 0x1000000 +
      ((byteAt(bytes, offset + 2) << 16) |
        (byteAt(bytes, offset + 3) << 8) |
        byteAt(bytes, offset + 4))
    return { majorType, value, headerLength: 5 }
  }
  // 27 (8-byte) and 28-31 (reserved, or indefinite length) do not occur anywhere in a Byron
  // address. Treated as invalid input rather than decoded.
  throw new Error(`unsupported CBOR additional info ${info}`)
}

const CBOR_MAJOR_UNSIGNED_INT = 0
const CBOR_MAJOR_NEGATIVE_INT = 1
const CBOR_MAJOR_BYTE_STRING = 2
const CBOR_MAJOR_TEXT_STRING = 3
const CBOR_MAJOR_ARRAY = 4
const CBOR_MAJOR_MAP = 5
const CBOR_MAJOR_TAG = 6
const CBOR_TAG_ENCODED_CBOR = 24

/** The address root is a blake2b-224 digest: always 28 bytes. */
const BYRON_ADDRESS_ROOT_BYTES = 28

/**
 * The address type, a uint tagging how the root is spent. cardano-ledger's Byron format defines
 * exactly three: 0 public-key, 1 script, 2 redeem (the AVVM vouchers). Anything else is not a
 * Byron address, so an out-of-range value is rejected rather than passed through.
 */
const VALID_BYRON_ADDRESS_TYPES = new Set([0, 1, 2])

/**
 * Skip exactly one CBOR item at `offset` and return the offset just past it. Used to walk the
 * address attributes map, whose contents this validator does not otherwise care about: it only
 * needs to know where the map ends so it can confirm the address type follows and nothing trails.
 *
 * Definite-length only, like readCborHeader, and it deliberately refuses major type 7
 * (simple values, floats): Byron never emits one inside an address, so encountering one is
 * malformed input, and throwing lands on isByronAddress's `false` rather than mis-skipping.
 */
function skipCborItem(bytes: Uint8Array, offset: number): number {
  const header = readCborHeader(bytes, offset)
  let next = offset + header.headerLength
  switch (header.majorType) {
    case CBOR_MAJOR_UNSIGNED_INT:
    case CBOR_MAJOR_NEGATIVE_INT:
      return next
    case CBOR_MAJOR_BYTE_STRING:
    case CBOR_MAJOR_TEXT_STRING:
      if (next + header.value > bytes.length) throw new Error('truncated CBOR string')
      return next + header.value
    case CBOR_MAJOR_ARRAY:
      for (let i = 0; i < header.value; i += 1) next = skipCborItem(bytes, next)
      return next
    case CBOR_MAJOR_MAP:
      for (let i = 0; i < header.value; i += 1) {
        next = skipCborItem(bytes, next)
        next = skipCborItem(bytes, next)
      }
      return next
    case CBOR_MAJOR_TAG:
      return skipCborItem(bytes, next)
    default:
      throw new Error(`unskippable CBOR major type ${header.majorType}`)
  }
}

/**
 * Whether `payload` (the decoded content of the tag-24 byte string) is a real Byron address body:
 * the CBOR array `[addressRoot, addressAttributes, addressType]`, where the root is a 28-byte
 * bytestring, the attributes are a map, and the type is a known uint variant, with the three
 * elements consuming the payload exactly and nothing trailing.
 *
 * Without this, the outer envelope and its CRC32 can be forged: wrap any CBOR value in the
 * accepted `[ #6.24(bytes), uint ]` shape, recompute the checksum over it, and the old check
 * passed it as a Byron address. The checksum only proves the bytes were not corrupted in transit,
 * not that they mean anything, so the structure has to be decoded to actually validate it.
 */
function isByronAddressPayload(payload: Uint8Array): boolean {
  let offset = 0

  const body = readCborHeader(payload, offset)
  if (body.majorType !== CBOR_MAJOR_ARRAY || body.value !== 3) return false
  offset += body.headerLength

  const root = readCborHeader(payload, offset)
  if (root.majorType !== CBOR_MAJOR_BYTE_STRING || root.value !== BYRON_ADDRESS_ROOT_BYTES) {
    return false
  }
  offset += root.headerLength
  if (offset + root.value > payload.length) return false
  offset += root.value

  const attributes = readCborHeader(payload, offset)
  if (attributes.majorType !== CBOR_MAJOR_MAP) return false
  offset += attributes.headerLength
  for (let i = 0; i < attributes.value; i += 1) {
    offset = skipCborItem(payload, offset)
    offset = skipCborItem(payload, offset)
  }

  const type = readCborHeader(payload, offset)
  if (type.majorType !== CBOR_MAJOR_UNSIGNED_INT || !VALID_BYRON_ADDRESS_TYPES.has(type.value)) {
    return false
  }
  offset += type.headerLength

  // Exactly the three elements and nothing else inside the tagged payload.
  return offset === payload.length
}

/**
 * Whether `value` is a real, structurally valid Byron address: base58 decodes, the outer CBOR
 * shape matches `[ #6.24(bytes), uint ]`, the tagged byte string decodes to a Byron address body
 * `[addressRoot, addressAttributes, addressType]` and nothing else, and the CRC32 of that byte
 * string matches the trailing uint. Every failure mode (bad base58 charset, truncation, wrong
 * outer or inner CBOR shape, a forged envelope wrapping a non-Byron value, a mismatched checksum,
 * trailing bytes) returns `false` rather than throwing, so this composes directly with the bech32
 * check next to it at the HTTP boundary.
 */
export function isByronAddress(value: string): boolean {
  try {
    const raw = base58.decode(value)
    let offset = 0

    const outer = readCborHeader(raw, offset)
    if (outer.majorType !== CBOR_MAJOR_ARRAY || outer.value !== 2) return false
    offset += outer.headerLength

    const tag = readCborHeader(raw, offset)
    if (tag.majorType !== CBOR_MAJOR_TAG || tag.value !== CBOR_TAG_ENCODED_CBOR) return false
    offset += tag.headerLength

    const payloadHeader = readCborHeader(raw, offset)
    if (payloadHeader.majorType !== CBOR_MAJOR_BYTE_STRING) return false
    offset += payloadHeader.headerLength
    if (offset + payloadHeader.value > raw.length) return false
    const payload = raw.subarray(offset, offset + payloadHeader.value)
    offset += payloadHeader.value

    const checksum = readCborHeader(raw, offset)
    if (checksum.majorType !== CBOR_MAJOR_UNSIGNED_INT) return false
    offset += checksum.headerLength

    // Exactly the two array elements and nothing else trailing.
    if (offset !== raw.length) return false

    // The checksum only proves the tagged bytes are intact, not that they are a Byron address.
    // Decode and validate the body before trusting the envelope.
    if (!isByronAddressPayload(payload)) return false

    return crc32(payload) === checksum.value
  } catch {
    return false
  }
}
