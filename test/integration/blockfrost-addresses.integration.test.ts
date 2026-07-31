import { describe, expect, it } from 'vitest'
import {
  BLOCKFROST_PROJECT_ID,
  discover,
  integrationProvider,
} from './support/provider-blockfrost.js'
import { alternatePaymentAddress } from '../support/alternate-payment-address.js'

const skip = BLOCKFROST_PROJECT_ID === undefined

interface PoolExtended {
  reward_account: string
}

interface AccountAddress {
  address: string
}

describe('blockfrost addresses (integration)', () => {
  it.skipIf(skip)(
    'reports a live address as used and a checksum-valid alternate as unused',
    async () => {
      // A registered pool's reward account controls at least one real address; pick one at
      // runtime so the test does not rot.
      const pools = await discover<PoolExtended[]>('/pools/extended?count=1')
      const rewardAddress = pools[0]?.reward_account
      expect(rewardAddress).toMatch(/^stake_test1[0-9a-z]+$/)

      const owned = await discover<AccountAddress[]>(`/accounts/${rewardAddress}/addresses?count=1`)
      const usedAddress = owned[0]?.address
      expect(usedAddress).toBeDefined()

      // Same valid address shape/network/delegation credential, but a deterministic alternate
      // payment credential and a recomputed checksum. Blockfrost can therefore answer the actual
      // question ("has this address appeared?") rather than rejecting malformed Bech32 first.
      const unused = alternatePaymentAddress(usedAddress as string)

      const result = await integrationProvider().filterUsedAddresses([
        usedAddress as string,
        unused,
      ])

      expect(result).toEqual([usedAddress])
    },
  )
})
