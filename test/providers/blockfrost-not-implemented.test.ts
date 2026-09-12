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
 * The one capability this driver still does not cover is `filterUsedPaymentCredentials`, and not
 * because it is unbuilt: Blockfrost has no payment-credential index to serve it from. It answers
 * `NotImplementedError` (501) rather than a generic error or a silently empty result. Asset,
 * governance and pool reads, transaction/reward history and utxo-by-reference used to live here and
 * are now implemented, each covered by its own suite.
 */
describe('blockfrost provider — capabilities not yet implemented', () => {
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
