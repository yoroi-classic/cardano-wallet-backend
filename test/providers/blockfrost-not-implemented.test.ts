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
 * The capabilities this driver still does not cover: assets, governance, pools, and
 * `filterUsedPaymentCredentials` — the last not because it is unbuilt but because Blockfrost has no
 * payment-credential index to serve it from. Each answers `NotImplementedError` (501) rather than a
 * generic error or a silently empty result. Transaction/reward history and utxo-by-reference are now
 * implemented and covered by their own suites.
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

  it('filterUsedPaymentCredentials', async () => {
    const provider = testProvider()
    await expect(provider.filterUsedPaymentCredentials(['a'.repeat(56)])).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })

  it('filterUsedPaymentCredentials names the missing payment-credential index', async () => {
    const provider = testProvider()
    // The message must state the real reason rather than the generic "not built yet", so issue #111
    // can record that this is a provider limitation, not a follow-up.
    await expect(provider.filterUsedPaymentCredentials(['a'.repeat(56)])).rejects.toThrow(
      /payment-credential index/,
    )
  })
})
