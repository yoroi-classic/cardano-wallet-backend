import { describe, expect, it } from 'vitest'
import { isByronAddress } from '../../src/domain/byron-address.js'

// Real addresses, not placeholders. The issue this fixes (yoroi-classic/cardano-wallet-backend#90)
// was found because a previous PR's tests used fake strings like "addr_test1_first", which the
// branded address types accept without ever exercising real decoding.
//
// Icarus-style (sequential derivation): from the issue itself, live-verified against Koios
// /address_info ("Ae2..." resolves with balance "0" and stake_address null).
const ICARUS = 'Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi'
// Daedalus-style (random derivation, carries an encrypted HD payload in its attributes, which is
// why it is longer): a real address posted in a public issue about decoding Daedalus addresses
// (CardanoSharp/cardanosharp-wallet#35). Independently verified here: it base58-decodes, its CBOR
// shape matches [ #6.24(bytes), uint ], and the CRC32 of the tagged content matches the trailing
// uint.
const DAEDALUS =
  'DdzFFzCqrht9W56zJGEFvHHywdeXZiGVYGqVhoZj6SRrS9o2HNLmorEzZhKm7khqfBKvCaTKGLtTnQSToxuvdzJTkQqcAf6f2ErxbSKS'

describe('isByronAddress — happy path', () => {
  it('accepts a real Icarus-style (Ae2) address', () => {
    expect(isByronAddress(ICARUS)).toBe(true)
  })

  it('accepts a real Daedalus-style (Ddz) address', () => {
    expect(isByronAddress(DAEDALUS)).toBe(true)
  })
})

describe('isByronAddress — regression', () => {
  // Locks the format contract: this must keep matching a fixed CBOR shape and a real CRC32, not
  // merely "looks like base58", or a Byron address could pass here without actually being one.
  it('still requires the CBOR array-of-two-with-tag-24 shape and a matching CRC32', () => {
    expect(isByronAddress(ICARUS)).toBe(true)
    expect(isByronAddress(DAEDALUS)).toBe(true)
  })

  // Both real fixtures happen to carry a CRC big enough to need the 4-byte CBOR uint encoding.
  // This one is constructed (a random 20-byte payload, CRC32'd, wrapped in the same
  // array/tag-24/bytestring shape) specifically so its CRC falls in the 256-65535 range, which
  // the CBOR reader encodes with its 2-byte form. Locks that the hand-rolled reader handles that
  // encoding too, not only the one both live fixtures happen to exercise.
  it('accepts a constructed address whose CRC uses the CBOR 2-byte uint encoding', () => {
    expect(isByronAddress('2M4A5ZZXZko8ZTkRLLf62XwDWUqyUn73hoTMSAG')).toBe(true)
  })
})

describe('isByronAddress — unhappy path', () => {
  it('rejects an empty string', () => {
    expect(isByronAddress('')).toBe(false)
  })

  it('rejects truncated base58 (valid charset, but the CBOR/CRC no longer lines up)', () => {
    expect(isByronAddress(ICARUS.slice(0, ICARUS.length - 5))).toBe(false)
  })

  it('rejects a single transposed character (breaks the CRC32 without breaking the charset)', () => {
    const chars = ICARUS.split('')
    const mid = Math.floor(chars.length / 2)
    const swapped = chars[mid]
    chars[mid] = chars[mid + 1] as string
    chars[mid + 1] = swapped as string
    expect(isByronAddress(chars.join(''))).toBe(false)
  })

  it('rejects a well-formed base58 string of unrelated data', () => {
    // 32 arbitrary bytes, base58 encoded: valid base58, but not the Byron CBOR shape at all.
    expect(isByronAddress('B6z3a9vmdUxT7aXRfMUK7w3GUUnybXmx7xPBRGwuAuU5')).toBe(false)
  })

  it('rejects a string with characters outside the base58 alphabet', () => {
    // '0' (zero) is not in the base58 alphabet.
    expect(isByronAddress(`${ICARUS}0`)).toBe(false)
  })

  it('rejects a bech32 Shelley address', () => {
    expect(
      isByronAddress(
        'addr_test1qpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5ewvxwdrt70qlcpeeagscasafhffqsxy36t90ldv06wqrk2qum8x5w',
      ),
    ).toBe(false)
  })

  // Constructed: an indefinite-length byte string (additional info 31), which CBOR permits in
  // general but Byron never emits and this reader does not support. Must reject cleanly rather
  // than throw past the boundary.
  it('rejects a CBOR shape using an unsupported additional-info encoding', () => {
    expect(isByronAddress('2fbf5n9osZeCg')).toBe(false)
  })
})
