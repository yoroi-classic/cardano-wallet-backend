import { describe, expect, it } from 'vitest'
import { TOKEN_SOURCES } from '../../src/domain/types/assets.js'
import {
  BLOCKFROST_PROJECT_ID,
  discover,
  integrationProvider,
} from './support/provider-blockfrost.js'

const skip = BLOCKFROST_PROJECT_ID === undefined

interface AssetListItem {
  asset: string
}

describe('blockfrost assets (integration)', () => {
  it.skipIf(skip)('returns token metadata for a live on-chain asset', async () => {
    // Pick a real asset at runtime so the test can't rot. Registry metadata is sparse on preprod,
    // so assert the on-chain basics every asset has plus that source is one of the known kinds.
    const assets = await discover<AssetListItem[]>('/assets?count=1&page=5')
    const subject = assets[0]?.asset
    expect(subject).toMatch(/^[0-9a-f]{56,}$/)

    const [token] = await integrationProvider().getTokenMetadata([subject as string])

    expect(token?.subject).toBe(subject)
    expect(token?.policyId).toBe((subject as string).slice(0, 56))
    expect(token?.assetName).toBe((subject as string).slice(56))
    expect(token?.fingerprint).toMatch(/^asset1[0-9a-z]+$/)
    expect(BigInt(token?.supply ?? '0')).toBeGreaterThanOrEqual(0n)
    expect(TOKEN_SOURCES).toContain(token?.source)
  })

  it.skipIf(skip)('omits an unknown subject rather than erroring', async () => {
    // A well-formed but almost-certainly-nonexistent subject: a policy id of all f's.
    const missing = 'f'.repeat(56)

    await expect(integrationProvider().getTokenMetadata([missing])).resolves.toEqual([])
  })
})
