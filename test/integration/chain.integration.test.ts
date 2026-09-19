import { describe, expect, it } from 'vitest'
import { integrationProvider } from './support/provider.js'

const provider = integrationProvider()

describe('koios chain (integration)', () => {
  it('returns a live chain tip', async () => {
    const tip = await provider.getTip()
    expect(tip.block).toBeGreaterThan(0)
    expect(tip.epoch).toBeGreaterThan(0)
    expect(tip.slot).toBeGreaterThan(0)
    expect(tip.hash).toMatch(/^[0-9a-f]+$/i)
    // A Cardano block hash is a 64-char Blake2b-256 hex string; guard against a
    // truncated, padded, or mis-mapped field that still happens to look like hex.
    expect(tip.hash).toHaveLength(64)
  })

  it('returns protocol params including plutus cost models', async () => {
    const params = await provider.getProtocolParams()
    expect(params.minFeeA).toBeGreaterThan(0)
    expect(params.minFeeB).toBeGreaterThan(0)
    expect(BigInt(params.coinsPerUtxoByte)).toBeGreaterThan(0n)
    expect(Object.keys(params.costModels).length).toBeGreaterThan(0)
  })
})
