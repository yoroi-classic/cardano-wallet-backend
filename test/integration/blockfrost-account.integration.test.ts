import { describe, expect, it } from 'vitest'
import {
  BLOCKFROST_PROJECT_ID,
  discover,
  integrationProvider,
} from './support/provider-blockfrost.js'

const skip = BLOCKFROST_PROJECT_ID === undefined

interface PoolExtended {
  reward_account: string
}

describe('blockfrost account (integration)', () => {
  it.skipIf(skip)(
    'returns account state whose reward totals satisfy the accounting identity',
    async () => {
      // A registered pool's own reward account is registered and has real reward/withdrawal
      // history; pick one at runtime so the test does not rot. rewardsSum - withdrawalsSum ==
      // rewardsAvailable is an accounting identity that must hold for any registered account.
      const pools = await discover<PoolExtended[]>('/pools/extended?count=1')
      const rewardAddress = pools[0]?.reward_account
      expect(rewardAddress).toMatch(/^stake_test1[0-9a-z]+$/)

      const state = await integrationProvider().getAccountState(rewardAddress as string)

      expect(state.registered).toBe(true)
      expect(BigInt(state.rewardsSum) - BigInt(state.withdrawalsSum)).toBe(
        BigInt(state.rewardsAvailable),
      )
      expect(BigInt(state.rewardsSum)).toBeGreaterThanOrEqual(BigInt(state.withdrawalsSum))
    },
  )

  it.skipIf(skip)('returns the utxos controlled by the same registered account', async () => {
    const pools = await discover<PoolExtended[]>('/pools/extended?count=1')
    const rewardAddress = pools[0]?.reward_account
    expect(rewardAddress).toMatch(/^stake_test1[0-9a-z]+$/)

    const utxos = await integrationProvider().getAccountUtxos(rewardAddress as string)

    for (const utxo of utxos) {
      expect(utxo.txHash).toMatch(/^[0-9a-f]{64}$/)
      expect(BigInt(utxo.value)).toBeGreaterThan(0n)
    }
  })
})
