import type { ChainProvider } from '../provider.js'
import { createAccountMethods } from './account.js'
import { createAddressMethods } from './addresses.js'
import { createAssetMethods } from './assets.js'
import { createChainMethods } from './chain.js'
import { createGovernanceMethods } from './governance.js'
import { createKoiosClient, type KoiosConfig } from './client.js'
import { createPoolMethods } from './pools.js'
import { createTxMethods } from './tx.js'

export type { FetchLike, KoiosConfig } from './client.js'

/**
 * The Koios provider: one shared client (auth, timeout, error mapping, parsing) with a
 * module per capability composed on top. A new area of the API is a new module and one
 * more spread here, so it never has to edit an existing module.
 */
export function createKoiosProvider(config: KoiosConfig): ChainProvider {
  const koios = createKoiosClient(config)

  return {
    name: 'koios',
    ...createChainMethods(koios),
    ...createAccountMethods(koios),
    ...createAddressMethods(koios),
    ...createAssetMethods(koios),
    ...createGovernanceMethods(koios),
    ...createPoolMethods(koios),
    ...createTxMethods(koios),
  }
}
