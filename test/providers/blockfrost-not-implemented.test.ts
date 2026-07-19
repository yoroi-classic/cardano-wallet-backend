import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { NotImplementedError } from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'

// None of these methods should ever call out, so a fetch that always throws proves the
// rejection comes from the stub itself and not from some unexpected upstream call.
const neverFetch: FetchLike = async () => {
  throw new Error('this driver area is not implemented; it must not call fetch at all')
}

function testProvider() {
  return createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl: neverFetch })
}

/**
 * The capabilities this PR deliberately does not cover: assets, governance, pools, full
 * transaction/reward history, and resolving an arbitrary UTxO by reference. Each answers
 * `NotImplementedError` (501) rather than a generic error or a silently empty result — see
 * issue #4's status comment for what a follow-up PR should pick up.
 */
describe('blockfrost provider — capabilities not yet implemented', () => {
  it('getTokenMetadata', async () => {
    const provider = testProvider()
    await expect(provider.getTokenMetadata(['abc'])).rejects.toBeInstanceOf(NotImplementedError)
  })

  it('getDrepInfo', async () => {
    const provider = testProvider()
    await expect(provider.getDrepInfo(['drep1abc'])).rejects.toBeInstanceOf(NotImplementedError)
  })

  it('getDrepList', async () => {
    const provider = testProvider()
    await expect(provider.getDrepList({ limit: 10, offset: 0 })).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })

  it('getProposals', async () => {
    const provider = testProvider()
    await expect(provider.getProposals({ limit: 10, offset: 0 })).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })

  it('getPoolInfo', async () => {
    const provider = testProvider()
    await expect(provider.getPoolInfo(['pool1abc'])).rejects.toBeInstanceOf(NotImplementedError)
  })

  it('getPoolList', async () => {
    const provider = testProvider()
    await expect(provider.getPoolList({ limit: 10, offset: 0 })).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })

  it('getTxHistory', async () => {
    const provider = testProvider()
    await expect(provider.getTxHistory('stake_test1abc')).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })

  it('getRewardHistory', async () => {
    const provider = testProvider()
    await expect(provider.getRewardHistory('stake_test1abc')).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })

  it('getUtxosByRef', async () => {
    const provider = testProvider()
    await expect(provider.getUtxosByRef([`${'a'.repeat(64)}#0`])).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })
})
