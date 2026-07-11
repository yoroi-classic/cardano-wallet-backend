import { describe, expect, it } from 'vitest'
import { KOIOS_BASE_URL, integrationProvider } from './support/provider.js'

const provider = integrationProvider()

describe('koios account (integration)', () => {
  it('returns account state whose reward totals satisfy the accounting identity', async () => {
    // A pool's reward account is registered and has real reward/withdrawal history; pick one
    // at runtime so the test does not rot. rewardsSum - withdrawalsSum == rewardsAvailable is
    // an accounting identity that must hold for any registered account.
    const listRes = await fetch(`${KOIOS_BASE_URL}/pool_list?pool_status=eq.registered&limit=1`)
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
})
