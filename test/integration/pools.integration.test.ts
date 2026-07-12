import { describe, expect, it } from 'vitest'
import { discover, integrationProvider } from './support/provider.js'

const provider = integrationProvider()

describe('koios pools (integration)', () => {
  it('returns live pool info for a currently-registered pool', async () => {
    // Pick a registered pool at runtime so this can't rot when a hardcoded pool retires.
    const list = await discover<{ pool_id_bech32: string }>(
      '/pool_list?pool_status=eq.registered&limit=1',
    )
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
