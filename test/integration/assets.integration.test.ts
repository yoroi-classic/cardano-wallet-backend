import { describe, expect, it } from 'vitest'
import { TOKEN_SOURCES } from '../../src/domain/types/assets.js'
import { discover, discoverPost, integrationProvider } from './support/provider.js'

const provider = integrationProvider()

interface AssetRef {
  policy_id: string
  asset_name: string
}

/** Ask Koios for the raw rows behind a window of assets, so a test can pick one to assert on. */
function rawInfo<T>(assets: AssetRef[]): Promise<T[]> {
  return discoverPost<T>('/asset_info', {
    _asset_list: assets.map((a) => [a.policy_id, a.asset_name]),
  })
}

describe('koios assets (integration)', () => {
  it('returns token metadata for a live on-chain asset', async () => {
    // Pick a real asset at runtime so the test can't rot. Registry metadata is sparse on
    // preprod, so assert the on-chain basics that every asset has.
    const rows = await discover<AssetRef>('/asset_list?limit=1&offset=5')
    const asset = rows[0]
    expect(asset?.policy_id).toMatch(/^[0-9a-f]{56}$/)
    const subject = `${asset?.policy_id}${asset?.asset_name}`

    const [token] = await provider.getTokenMetadata([subject])

    expect(token?.subject).toBe(subject)
    expect(token?.policyId).toBe(asset?.policy_id)
    expect(token?.assetName).toBe(asset?.asset_name)
    expect(token?.fingerprint).toMatch(/^asset1[0-9a-z]+$/)
    expect(BigInt(token?.supply ?? '0')).toBeGreaterThanOrEqual(0n)
    // This asset is whichever one Koios happened to list first, so it can legitimately
    // resolve from any of the sources. The list has to name all of them, including cip68,
    // or the run fails whenever the picked asset happens to carry only a CIP-68 datum.
    expect(TOKEN_SOURCES).toContain(token?.source)
  })

  it('resolves CIP-25 mint metadata for a live NFT when one can be found', async () => {
    // Scan a bounded window for an asset carrying CIP-25 (label 721) metadata, then confirm
    // the mapping surfaces it as source 'cip25'. Skips if none turns up in the window.
    for (let offset = 0; offset < 200; offset += 25) {
      const list = await discover<AssetRef>(`/asset_list?limit=25&offset=${offset}`)
      if (list.length === 0) break

      const info = await rawInfo<
        AssetRef & { minting_tx_metadata?: Record<string, unknown> | null }
      >(list)
      const nft = info.find((a) => a.minting_tx_metadata && '721' in a.minting_tx_metadata)
      if (!nft) continue

      const [token] = await provider.getTokenMetadata([`${nft.policy_id}${nft.asset_name}`])

      // Registry can still win if this asset also registered; otherwise it must be cip25.
      expect(['registry', 'cip25']).toContain(token?.source)
      return
    }
  })

  it('resolves CIP-68 datum metadata for a live asset when one can be found', async () => {
    for (let offset = 0; offset < 400; offset += 25) {
      const list = await discover<AssetRef>(`/asset_list?limit=25&offset=${offset}`)
      if (list.length === 0) break

      const info = await rawInfo<
        AssetRef & {
          cip68_metadata?: unknown
          token_registry_metadata?: unknown
          minting_tx_metadata?: unknown
        }
      >(list)
      // Only assert on a "clean" CIP-68 asset (no registry/CIP-25 that would take priority).
      const cip68 = info.find(
        (a) => a.cip68_metadata && !a.token_registry_metadata && !a.minting_tx_metadata,
      )
      if (!cip68) continue

      const [token] = await provider.getTokenMetadata([`${cip68.policy_id}${cip68.asset_name}`])

      // A datum may carry no recognizable fields, in which case we fall through to 'none'.
      expect(['cip68', 'none']).toContain(token?.source)
      return
    }
  })
})
