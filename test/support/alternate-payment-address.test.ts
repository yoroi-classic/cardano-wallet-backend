import { bech32 } from '@scure/base'
import { describe, expect, it } from 'vitest'
import { alternatePaymentAddress } from './alternate-payment-address.js'

const USED =
  'addr_test1qpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5ewvxwdrt70qlcpeeagscasafhffqsxy36t90ldv06wqrk2qum8x5w'
const BECH32_LIMIT = 1023

function bytes(address: string): Uint8Array {
  const decoded = bech32.decode(address, BECH32_LIMIT)
  return bech32.fromWords(decoded.words)
}

describe('alternate payment address fixture', () => {
  it('re-encodes a deterministic checksum-valid address with only its payment credential changed', () => {
    const alternate = alternatePaymentAddress(USED)
    const originalDecoded = bech32.decode(USED, BECH32_LIMIT)
    const alternateDecoded = bech32.decode(alternate, BECH32_LIMIT)
    const originalBytes = bytes(USED)
    const alternateBytes = bytes(alternate)

    expect(alternate).not.toBe(USED)
    expect(alternate).toBe(alternatePaymentAddress(USED))
    expect(alternateDecoded.prefix).toBe(originalDecoded.prefix)
    expect(alternateBytes).toHaveLength(originalBytes.length)
    expect(alternateBytes[0]).toBe(originalBytes[0])
    expect(alternateBytes.slice(1, 29)).not.toEqual(originalBytes.slice(1, 29))
    expect(alternateBytes.slice(29)).toEqual(originalBytes.slice(29))
  })

  it('demonstrates that changing the encoded checksum character is malformed instead', () => {
    const invented = USED.replace(/.$/, (char) => (char === 'q' ? 'p' : 'q'))

    expect(bech32.decodeUnsafe(invented, BECH32_LIMIT)).toBeUndefined()
  })
})
