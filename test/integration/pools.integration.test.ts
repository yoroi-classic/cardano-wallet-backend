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
    const rows = await discover<{ ticker: string | null }>(
      '/pool_list?pool_status=eq.registered&ticker=not.is.null&select=ticker&limit=1',
    )
    const ticker = rows[0]?.ticker
    // Some networks may have no ticker'd pools; only assert when one exists.
    if (!ticker || !/^[A-Za-z0-9]{1,15}$/.test(ticker)) return

    const pools = await provider.getPoolList({ limit: 10, offset: 0, ticker })
    expect(pools.length).toBeGreaterThan(0)
    for (const pool of pools) {
      expect(pool.metadata?.ticker?.toLowerCase()).toContain(ticker.toLowerCase())
    }
  })
})
