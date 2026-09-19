import { describe, expect, it } from 'vitest'
import { BLOCKFROST_PROJECT_ID, integrationProvider } from './support/provider-blockfrost.js'

const skip = BLOCKFROST_PROJECT_ID === undefined

describe('blockfrost chain (integration)', () => {
  it.skipIf(skip)('returns a live chain tip', async () => {
    const tip = await integrationProvider().getTip()

    expect(tip.block).toBeGreaterThan(0)
    expect(tip.epoch).toBeGreaterThan(0)
    expect(tip.slot).toBeGreaterThan(0)
    // A Cardano block hash is a 64-char Blake2b-256 hex string; guard against a truncated,
    // padded, or mis-mapped field that still happens to look like hex.
    expect(tip.hash).toMatch(/^[0-9a-f]+$/i)
    expect(tip.hash).toHaveLength(64)
  })

  it.skipIf(skip)(
    'returns protocol params, and reports whether cost models are present',
    async () => {
      const params = await integrationProvider().getProtocolParams()

      expect(params.minFeeA).toBeGreaterThan(0)
      expect(params.minFeeB).toBeGreaterThan(0)
      expect(BigInt(params.coinsPerUtxoByte)).toBeGreaterThan(0n)

      // Not a hard assertion: this is exactly the gap flagged in issue #4. Blockfrost's hosted
      // service is expected to carry cost models on a live network, so this fails loudly if that
      // ever stops being true, rather than only finding out from a wallet failing to build a
      // script transaction.
      expect(Object.keys(params.costModels).length).toBeGreaterThan(0)
    },
  )
})
