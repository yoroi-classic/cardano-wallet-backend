import { describe, expect, it } from 'vitest'
import {
  BLOCKFROST_PROJECT_ID,
  discover,
  integrationProvider,
} from './support/provider-blockfrost.js'

const skip = BLOCKFROST_PROJECT_ID === undefined

interface PoolExtended {
  pool_id: string
}

describe('blockfrost pools (integration)', () => {
  it.skipIf(skip)('returns live pool info for a currently-registered pool', async () => {
    // Pick a registered pool at runtime so this can't rot when a hardcoded pool retires.
    const list = await discover<PoolExtended[]>('/pools/extended?count=1')
    const poolId = list[0]?.pool_id
    expect(poolId).toMatch(/^pool1[0-9a-z]+$/)

    const pools = await integrationProvider().getPoolInfo([poolId as string])
    expect(pools).toHaveLength(1)
    const pool = pools[0]
    expect(pool?.poolId).toBe(poolId)
    expect(pool?.poolIdHex).toMatch(/^[0-9a-f]{56}$/)
    expect(pool?.status).toBe('registered')
    expect(pool?.margin).toBeGreaterThanOrEqual(0)
    expect(pool?.margin).toBeLessThanOrEqual(1)
    expect(BigInt(pool?.liveStake ?? '0')).toBeGreaterThanOrEqual(0n)
    expect(pool?.saturation).toBeGreaterThanOrEqual(0)
  })

  it.skipIf(skip)('returns a neutrally-ordered page, largest active stake first', async () => {
    const pools = await integrationProvider().getPoolList({ limit: 5, offset: 0 })
    expect(pools.length).toBeGreaterThan(0)
    expect(pools.length).toBeLessThanOrEqual(5)
    for (const pool of pools) {
      expect(pool.poolId).toMatch(/^pool1[0-9a-z]+$/)
      expect(pool.status).toBe('registered')
    }
    for (let i = 1; i < pools.length; i += 1) {
      expect(BigInt(pools[i - 1]?.activeStake ?? '0') >= BigInt(pools[i]?.activeStake ?? '0')).toBe(
        true,
      )
    }
  })

  it.skipIf(skip)('filters the pool list by ticker', async () => {
    // Find a real registered ticker at runtime so the assertion can't rot.
    const rows = await discover<{ metadata: { ticker: string | null } | null }[]>(
      '/pools/extended?count=20',
    )
    const ticker = rows
      .map((r) => r.metadata?.ticker)
      .find((t) => t && /^[A-Za-z0-9]{2,15}$/.test(t))
    if (!ticker) return

    const pools = await integrationProvider().getPoolList({ limit: 10, offset: 0, ticker })
    expect(pools.length).toBeGreaterThan(0)
    for (const pool of pools) {
      expect(pool.metadata?.ticker?.toLowerCase()).toContain(ticker.toLowerCase())
    }
  })
})
