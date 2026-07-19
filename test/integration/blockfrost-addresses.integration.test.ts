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

interface AccountAddress {
  address: string
}

describe('blockfrost addresses (integration)', () => {
  it.skipIf(skip)(
    'reports a live, used address as used and an invented one as unused',
    async () => {
      // A registered pool's reward account controls at least one real address; pick one at
      // runtime so the test does not rot.
      const pools = await discover<PoolExtended[]>('/pools/extended?count=1')
      const rewardAddress = pools[0]?.reward_account
      expect(rewardAddress).toMatch(/^stake_test1[0-9a-z]+$/)

      const owned = await discover<AccountAddress[]>(`/accounts/${rewardAddress}/addresses?count=1`)
      const usedAddress = owned[0]?.address
      expect(usedAddress).toBeDefined()

      // Same shape, but not a real payment credential: the used-address check has to answer
      // "no" for this rather than mistaking a well-formed-looking address for a seen one.
      const invented = (usedAddress as string).replace(/.$/, (c) => (c === 'q' ? 'p' : 'q'))

      const result = await integrationProvider().filterUsedAddresses([
        usedAddress as string,
        invented,
      ])

      expect(result).toEqual([usedAddress])
    },
  )

  it.skipIf(skip)('returns the utxos and transaction history of a live used address', async () => {
    const pools = await discover<PoolExtended[]>('/pools/extended?count=1')
    const rewardAddress = pools[0]?.reward_account
    const owned = await discover<AccountAddress[]>(`/accounts/${rewardAddress}/addresses?count=1`)
    const usedAddress = owned[0]?.address
    expect(usedAddress).toBeDefined()

    const provider = integrationProvider()
    const utxos = await provider.getUtxosByAddresses([usedAddress as string])
    for (const utxo of utxos) {
      expect(utxo.address).toBe(usedAddress)
      expect(utxo.txHash).toMatch(/^[0-9a-f]{64}$/)
      expect(BigInt(utxo.value)).toBeGreaterThan(0n)
    }

    const history = await provider.getTxHistoryByAddresses([usedAddress as string])
    expect(history.length).toBeGreaterThan(0)
    for (let i = 1; i < history.length; i += 1) {
      expect(history[i]!.block).toBeGreaterThanOrEqual(history[i - 1]!.block)
    }
    for (const tx of history) {
      expect(tx.txHash).toMatch(/^[0-9a-f]{64}$/)
      expect(tx.epoch).toBeGreaterThan(0)
    }
  })
})
