import { noCache, type Cache } from '../../cache/index.js'
import { TIP_CACHE_KEY, TIP_TTL_MS } from '../cached.js'
import type { ChainProvider } from '../provider.js'
import { createAccountMethods } from './account.js'
import { createAddressMethods } from './addresses.js'
import { createAssetMethods } from './assets.js'
import { createChainMethods } from './chain.js'
import { createGovernanceMethods } from './governance.js'
import { createKoiosClient, type KoiosConfig } from './client.js'
import { createPoolMethods } from './pools.js'
import { createTxMethods } from './tx.js'

export type { FetchLike, KoiosConfig, RetryEvent } from './client.js'

export interface KoiosProviderOptions extends KoiosConfig {
  /**
   * Cache for the reads whose expensive part is *internal*.
   *
   * Most caching happens outside this provider, in `withCache`, which caches the normalized
   * result of a whole capability call. That is the right place for it and remains where the
   * policy is written down.
   *
   * It cannot reach the pool ranking, though, and that is why this exists. The expensive thing
   * in `getPoolList` is not the result but the full registered-set scan the ordering is computed
   * from, and a decorator caching by `(limit, offset)` would cache each *page* while every cold
   * page still triggered the whole scan. Caching that intermediate needs to happen where the
   * intermediate is.
   */
  cache?: Cache
}

/**
 * The Koios provider: one shared client (auth, timeout, error mapping, parsing) with a
 * module per capability composed on top. A new area of the API is a new module and one
 * more spread here, so it never has to edit an existing module.
 */
export function createKoiosProvider(options: KoiosProviderOptions): ChainProvider {
  const { cache = noCache, ...config } = options
  const koios = createKoiosClient(config)

  const chain = createChainMethods(koios)

  // The epoch, from the same cache entry and the same TTL the rest of the service reads the tip
  // through. Deliberately not a second key: two keys for one tip would mean two upstream reads,
  // and at an epoch boundary they could briefly disagree about which epoch it is, so the pool
  // ranking would be keyed on an epoch nobody else believed in.
  const currentEpoch = async (): Promise<number> =>
    (await cache.read(TIP_CACHE_KEY, TIP_TTL_MS, () => chain.getTip())).epoch

  return {
    name: 'koios',
    ...chain,
    ...createAccountMethods(koios),
    ...createAddressMethods(koios),
    ...createAssetMethods(koios),
    ...createGovernanceMethods(koios),
    ...createPoolMethods(koios, { cache, currentEpoch }),
    ...createTxMethods(koios),
  }
}
