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
 * check, and transaction submit/status are real. Asset, governance, and pool reads, plus full
 * transaction history and reward history and arbitrary UTxO-by-reference resolution, are stubbed
 * with `NotImplementedError` — see the individual capability modules and issue #4's status
 * comment for exactly what is left.
 */
export function createBlockfrostProvider(config: BlockfrostConfig): ChainProvider {
  const client = createBlockfrostClient(config)

  return {
    name: 'blockfrost',
    ...createChainMethods(client),
    ...createAccountMethods(client),
    ...createAddressMethods(client),
    ...createAssetMethods(),
    ...createGovernanceMethods(),
    ...createPoolMethods(),
    ...createTxMethods(client),
  }
}
