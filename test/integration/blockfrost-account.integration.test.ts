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

  it.skipIf(skip)(
    'returns reward history, oldest first, with a derived spendable epoch',
    async () => {
      // A registered pool's own reward account has earned real rewards over many epochs.
      const pools = await discover<PoolExtended[]>('/pools/extended?count=1')
      const rewardAddress = pools[0]?.reward_account
      expect(rewardAddress).toMatch(/^stake_test1[0-9a-z]+$/)

      const rewards = await integrationProvider().getRewardHistory(rewardAddress as string)

      expect(rewards.length).toBeGreaterThan(0)
      for (let i = 1; i < rewards.length; i += 1) {
        // Oldest first: earned epochs never decrease.
        expect(rewards[i]!.earnedEpoch).toBeGreaterThanOrEqual(rewards[i - 1]!.earnedEpoch)
      }
      for (const r of rewards) {
        expect(r.spendableEpoch).toBe(r.earnedEpoch + 2)
        expect(BigInt(r.amount)).toBeGreaterThanOrEqual(0n)
        expect(['member', 'leader', 'refund']).toContain(r.kind)
      }
    },
  )

  it.skipIf(skip)('returns a stake account transaction history, oldest first', async () => {
    const pools = await discover<PoolExtended[]>('/pools/extended?count=1')
    const rewardAddress = pools[0]?.reward_account
    expect(rewardAddress).toMatch(/^stake_test1[0-9a-z]+$/)

    const history = await integrationProvider().getTxHistory(rewardAddress as string)

    expect(history.length).toBeGreaterThan(0)
    for (let i = 1; i < history.length; i += 1) {
      expect(history[i]!.block).toBeGreaterThanOrEqual(history[i - 1]!.block)
    }
    for (const tx of history) {
      expect(tx.txHash).toMatch(/^[0-9a-f]{64}$/)
      expect(tx.blockHash).toMatch(/^[0-9a-f]{64}$/)
      expect(tx.epoch).toBeGreaterThan(0)
      expect(tx.outputs.length).toBeGreaterThan(0)
    }
    // The hashes on one page are distinct: a self-transfer is collapsed, not repeated.
    const hashes = history.map((t) => t.txHash)
    expect(new Set(hashes).size).toBe(hashes.length)
  })
})
