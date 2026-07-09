import { describe, expect, it } from 'vitest'
import { createKoiosProvider } from '../../src/providers/koios.js'

// Hits real preprod Koios. Runs only in the integration suite (preprod/main gates),
// not in the default unit run. Uses the public free tier, no token required.
const provider = createKoiosProvider({
  baseUrl: process.env.KOIOS_URL ?? 'https://preprod.koios.rest/api/v1',
  token: process.env.KOIOS_TOKEN,
})

describe('koios preprod (integration)', () => {
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

  it('returns account state whose reward totals satisfy the accounting identity', async () => {
    // A pool's reward account is registered and has real reward/withdrawal history; pick one
    // at runtime so the test does not rot. rewardsSum - withdrawalsSum == rewardsAvailable is
    // an accounting identity that must hold for any registered account.
    const base = process.env.KOIOS_URL ?? 'https://preprod.koios.rest/api/v1'
    const listRes = await fetch(`${base}/pool_list?pool_status=eq.registered&limit=1`)
    const list = (await listRes.json()) as Array<{ reward_addr: string }>
    const rewardAddr = list[0]?.reward_addr
    expect(rewardAddr).toMatch(/^stake_test1[0-9a-z]+$/)

    const state = await provider.getAccountState(rewardAddr as string)
    expect(state.registered).toBe(true)
    expect(BigInt(state.rewardsSum) - BigInt(state.withdrawalsSum)).toBe(
      BigInt(state.rewardsAvailable),
    )
    expect(BigInt(state.rewardsSum)).toBeGreaterThanOrEqual(BigInt(state.withdrawalsSum))
  })

  it('returns live pool info for a currently-registered pool', async () => {
    // Pick a registered pool at runtime so this can't rot when a hardcoded pool retires.
    const base = process.env.KOIOS_URL ?? 'https://preprod.koios.rest/api/v1'
    const listRes = await fetch(`${base}/pool_list?pool_status=eq.registered&limit=1`)
    const list = (await listRes.json()) as Array<{ pool_id_bech32: string }>
    const poolId = list[0]?.pool_id_bech32
    expect(poolId).toMatch(/^pool1[0-9a-z]+$/)

    const pools = await provider.getPoolInfo([poolId as string])
    expect(pools).toHaveLength(1)
    const pool = pools[0]
    expect(pool?.poolId).toBe(poolId)
    // A pool id is a 28-byte Blake2b-224 key-hash, 56 hex chars.
    expect(pool?.poolIdHex).toMatch(/^[0-9a-f]{56}$/)
    expect(pool?.status).toBe('registered')
    expect(pool?.margin).toBeGreaterThanOrEqual(0)
    expect(pool?.margin).toBeLessThanOrEqual(1)
    expect(BigInt(pool?.liveStake ?? '0')).toBeGreaterThanOrEqual(0n)
    expect(pool?.saturation).toBeGreaterThanOrEqual(0)
  })

  it('returns a neutrally-ordered page of the pool list, largest active stake first', async () => {
    const pools = await provider.getPoolList({ limit: 5, offset: 0 })
    expect(pools.length).toBeGreaterThan(0)
    expect(pools.length).toBeLessThanOrEqual(5)
    for (const pool of pools) {
      expect(pool.poolId).toMatch(/^pool1[0-9a-z]+$/)
      expect(pool.status).toBe('registered')
    }
    // Ordered by active stake, descending.
    for (let i = 1; i < pools.length; i += 1) {
      const prev = pools[i - 1]
      const cur = pools[i]
      expect(BigInt(prev?.activeStake ?? '0') >= BigInt(cur?.activeStake ?? '0')).toBe(true)
    }
  })

  it('filters the pool list by ticker', async () => {
    // Find a real registered ticker at runtime so the assertion can't rot.
    const base = process.env.KOIOS_URL ?? 'https://preprod.koios.rest/api/v1'
    const res = await fetch(
      `${base}/pool_list?pool_status=eq.registered&ticker=not.is.null&select=ticker&limit=1`,
    )
    const rows = (await res.json()) as Array<{ ticker: string | null }>
    const ticker = rows[0]?.ticker
    // Some networks may have no ticker'd pools; only assert when one exists.
    if (!ticker || !/^[A-Za-z0-9]{1,15}$/.test(ticker)) return

    const pools = await provider.getPoolList({ limit: 10, offset: 0, ticker })
    expect(pools.length).toBeGreaterThan(0)
    for (const pool of pools) {
      expect(pool.metadata?.ticker?.toLowerCase()).toContain(ticker.toLowerCase())
    }
  })

  it('returns token metadata for a live on-chain asset', async () => {
    // Pick a real asset at runtime so the test can't rot. Registry metadata is sparse on
    // preprod, so assert the on-chain basics that every asset has.
    const base = process.env.KOIOS_URL ?? 'https://preprod.koios.rest/api/v1'
    const res = await fetch(`${base}/asset_list?limit=1&offset=5`)
    const rows = (await res.json()) as Array<{ policy_id: string; asset_name: string }>
    const asset = rows[0]
    expect(asset?.policy_id).toMatch(/^[0-9a-f]{56}$/)
    const subject = `${asset?.policy_id}${asset?.asset_name}`

    const [token] = await provider.getTokenMetadata([subject])
    expect(token?.subject).toBe(subject)
    expect(token?.policyId).toBe(asset?.policy_id)
    expect(token?.assetName).toBe(asset?.asset_name)
    expect(token?.fingerprint).toMatch(/^asset1[0-9a-z]+$/)
    expect(BigInt(token?.supply ?? '0')).toBeGreaterThanOrEqual(0n)
    expect(['registry', 'cip25', 'none']).toContain(token?.source)
  })

  it('resolves CIP-25 mint metadata for a live NFT when one can be found', async () => {
    // Scan a bounded window for an asset carrying CIP-25 (label 721) metadata, then confirm
    // our mapping surfaces it as source 'cip25'. Skips if none turns up in the window.
    const base = process.env.KOIOS_URL ?? 'https://preprod.koios.rest/api/v1'
    for (let offset = 0; offset < 200; offset += 25) {
      const listRes = await fetch(`${base}/asset_list?limit=25&offset=${offset}`)
      const list = (await listRes.json()) as Array<{ policy_id: string; asset_name: string }>
      if (list.length === 0) break
      const pairs = list.map((a) => [a.policy_id, a.asset_name])
      const infoRes = await fetch(`${base}/asset_info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _asset_list: pairs }),
      })
      const info = (await infoRes.json()) as Array<{
        policy_id: string
        asset_name: string
        minting_tx_metadata?: Record<string, unknown> | null
      }>
      const nft = info.find((a) => a.minting_tx_metadata && '721' in a.minting_tx_metadata)
      if (!nft) continue

      const subject = `${nft.policy_id}${nft.asset_name}`
      const [token] = await provider.getTokenMetadata([subject])
      // Registry can still win if this asset also registered; otherwise it must be cip25.
      expect(['registry', 'cip25']).toContain(token?.source)
      return
    }
  })
})
