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
const CBOR_MAJOR_BYTE_STRING = 2
const CBOR_MAJOR_ARRAY = 4
const CBOR_MAJOR_TAG = 6
const CBOR_TAG_ENCODED_CBOR = 24

/**
 * Whether `value` is a real, structurally valid Byron address: base58 decodes, the CBOR shape
 * matches `[ #6.24(bytes), uint ]`, and the CRC32 of the tagged byte string's content matches
 * the trailing uint. Every failure mode (bad base58 charset, truncation, wrong CBOR shape, a
 * mismatched checksum, trailing bytes after the two elements) returns `false` rather than
 * throwing, so this composes directly with the bech32 check next to it at the HTTP boundary.
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

    return crc32(payload) === checksum.value
  } catch {
    return false
  }
}
