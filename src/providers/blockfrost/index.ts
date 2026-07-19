import type { ChainProvider } from '../provider.js'
import { createAccountMethods } from './account.js'
import { createAddressMethods } from './addresses.js'
import { createAssetMethods } from './assets.js'
import { createChainMethods } from './chain.js'
import { createBlockfrostClient, type BlockfrostConfig } from './client.js'
import { createGovernanceMethods } from './governance.js'
import { createPoolMethods } from './pools.js'
import { createTxMethods } from './tx.js'

export type { BlockfrostConfig, FetchLike, RetryEvent } from './client.js'

/**
 * The Blockfrost provider: one shared client (auth via the `project_id` header, timeout, error
 * mapping, parsing) with a module per capability composed on top, mirroring the Koios provider's
 * shape exactly.
 *
 * Chain reads (`getTip`, `getProtocolParams`), stake-account state and UTxOs, the used-address
 * check, and transaction submit/status are real. Asset metadata, governance (DRep info/list and
 * proposals), and stake-pool (info/list) reads are now real as well, matching the Koios provider's
 * output shape as far as Blockfrost's API allows (see the individual capability modules for the
 * documented gaps, e.g. Blockfrost decoding CIP-68 datums server-side rather than exposing them,
 * and offering no proposal vote-summary endpoint).
 *
 * Still stubbed with `NotImplementedError`: full transaction history and reward history, arbitrary
 * UTxO-by-reference resolution, and the address-set reads (payment-credential filter, UTxOs and tx
 * history by address). Those may be landing in a parallel PR — see the account/addresses capability
 * modules and issue #4's status comment for exactly what is left.
 */
export function createBlockfrostProvider(config: BlockfrostConfig): ChainProvider {
  const client = createBlockfrostClient(config)

  return {
    name: 'blockfrost',
    ...createChainMethods(client),
    ...createAccountMethods(client),
    ...createAddressMethods(client),
    ...createAssetMethods(client),
    ...createGovernanceMethods(client),
    ...createPoolMethods(client),
    ...createTxMethods(client),
  }
}
