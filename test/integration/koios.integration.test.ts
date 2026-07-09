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
})
