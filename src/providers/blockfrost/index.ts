import { noCache, type Cache } from '../../cache/index.js'
import { TIP_CACHE_KEY, TIP_TTL_MS } from '../cached.js'
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

export interface BlockfrostProviderOptions extends BlockfrostConfig {
  /**
   * The process cache. Mirrors `KoiosProviderOptions.cache`: most caching happens in `withCache`,
   * outside this provider, but the pool ranking cannot be reached from there (its expensive part is
   * the internal registered-set scan, not the result), so the pool module takes the cache directly.
   */
  cache?: Cache
}

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
export function createBlockfrostProvider(options: BlockfrostProviderOptions): ChainProvider {
  const { cache = noCache, ...config } = options
  const client = createBlockfrostClient(config)

  const chain = createChainMethods(client)

  // The epoch, from the same cached tip and TTL the rest of the service reads the tip through, so
  // the pool ranking is keyed on the epoch everyone else believes in rather than a second one that
  // could disagree at a boundary. Same wiring as the Koios provider.
  const currentEpoch = async (): Promise<number> =>
    (await cache.read(TIP_CACHE_KEY, TIP_TTL_MS, () => chain.getTip())).epoch

  return {
    name: 'blockfrost',
    ...chain,
    ...createAccountMethods(client),
    ...createAddressMethods(client),
    ...createAssetMethods(client),
    ...createGovernanceMethods(client),
    ...createPoolMethods(client, { cache, currentEpoch }),
    ...createTxMethods(client),
  }
}
