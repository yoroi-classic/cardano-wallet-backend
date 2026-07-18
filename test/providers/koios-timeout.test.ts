import { describe, expect, it } from 'vitest'
import { HEAVY_PATHS, timeoutFor } from '../../src/providers/koios/client.js'

// Koios is bimodal, so the row-assembly endpoints get a longer per-request budget than the light
// reads. The two address-keyed reads assemble as many rows as their account-keyed siblings, so
// they must ride the heavy budget too rather than being abandoned on the 10s light-read timeout.
const LIGHT = 10_000
const HEAVY = 15_000

describe('timeoutFor', () => {
  it('gives the address-keyed row-assembly reads the heavy budget', () => {
    expect(timeoutFor('/address_utxos', LIGHT, HEAVY)).toBe(HEAVY)
    expect(timeoutFor('/address_txs', LIGHT, HEAVY)).toBe(HEAVY)
  })

  it('still matches a path carrying query parameters', () => {
    expect(
      timeoutFor('/address_utxos?order=tx_hash.asc,tx_index.asc&limit=1000&offset=0', LIGHT, HEAVY),
    ).toBe(HEAVY)
    expect(
      timeoutFor(
        '/address_txs?order=block_height.asc,tx_hash.asc&limit=1000&offset=0',
        LIGHT,
        HEAVY,
      ),
    ).toBe(HEAVY)
    expect(timeoutFor('/credential_txs?limit=1', LIGHT, HEAVY)).toBe(HEAVY)
  })

  it('keeps the light budget for a light read', () => {
    expect(timeoutFor('/tip', LIGHT, HEAVY)).toBe(LIGHT)
    expect(timeoutFor('/epoch_params', LIGHT, HEAVY)).toBe(LIGHT)
  })

  it('lists both address reads alongside their account siblings', () => {
    expect(HEAVY_PATHS).toEqual(
      expect.arrayContaining(['/address_utxos', '/address_txs', '/credential_txs']),
    )
    expect(HEAVY_PATHS).toEqual(expect.arrayContaining(['/account_utxos', '/account_txs']))
  })
})
