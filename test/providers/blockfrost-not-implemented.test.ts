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
 * The capabilities this PR deliberately does not cover: full transaction/reward history and
 * resolving an arbitrary UTxO by reference. Each answers `NotImplementedError` (501) rather than a
 * generic error or a silently empty result — see issue #4's status comment for what a follow-up PR
 * should pick up. Asset, governance, and pool reads used to live here; they are real as of this PR
 * and are covered by their own suites.
 */
describe('blockfrost provider — capabilities not yet implemented', () => {
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
