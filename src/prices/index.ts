import type { Cache } from '../cache/index.js'
import type {
  AdaPrice,
  Ohlc,
  PriceRange,
  PriceWindow,
  TokenActivity,
} from '../domain/types/price.js'
import { createCoingeckoClient } from './coingecko.js'
import { createGeckoTerminalClient } from './geckoterminal.js'
import type { FetchLike } from './http.js'

/**
 * Price and market data, assembled from two upstreams that each cover the part the other can't:
 * CoinGecko for ADA's own fiat price and history, GeckoTerminal for native-token price and
 * history, priced in ADA. See coingecko.ts and geckoterminal.ts for why the split falls there.
 *
 * This is not a `ChainProvider` capability: price has no on-chain source at all, so it does not
 * belong on the interface Koios/Blockfrost/Dingo implement. It follows the same shape as the other
 * optional, non-chain upstreams instead (see media/nftcdn.ts's `NftcdnSigner`,
 * remote-config/index.ts's `RemoteConfig`): a standalone factory, injected through `RouteDeps`.
 *
 * Unlike those two, this one needs no credential to work at the free tier, so `main()` builds it
 * unconditionally rather than gating it on configuration. The dependency stays optional in the
 * route/server types anyway, for the same reason the NFTCDN signer is: a test can build a server
 * with no price provider at all, and those routes fall back to the `501` they always have.
 */
export interface PriceProvider {
  getAdaPrice(currencies: string[]): Promise<AdaPrice>
  getAdaHistory(range: PriceRange, currency: string): Promise<Ohlc[]>
  getTokenActivity(subjects: string[], window: PriceWindow): Promise<TokenActivity[]>
  getTokenHistory(subject: string, range: PriceRange): Promise<Ohlc[]>
}

export interface PriceProviderConfig {
  /** Free "Demo" tier CoinGecko key. Absent works fine, just at a lower rate limit. */
  coingeckoApiKey?: string
  /**
   * The process cache, shared with everything else that caches. Passed in rather than built here
   * so there is exactly one cache instance; see providers/factory.ts's note on `createProvider`
   * for why that single-instance rule matters.
   */
  cache?: Cache
  /** Test-only overrides; production never sets these. */
  coingeckoFetchImpl?: FetchLike
  geckoTerminalFetchImpl?: FetchLike
}

export function createPriceProvider(config: PriceProviderConfig = {}): PriceProvider {
  const coingecko = createCoingeckoClient({
    apiKey: config.coingeckoApiKey,
    cache: config.cache,
    fetchImpl: config.coingeckoFetchImpl,
  })
  const geckoTerminal = createGeckoTerminalClient({
    cache: config.cache,
    fetchImpl: config.geckoTerminalFetchImpl,
  })

  return {
    getAdaPrice: (currencies) => coingecko.getAdaPrice(currencies),
    getAdaHistory: (range, currency) => coingecko.getAdaHistory(range, currency),
    getTokenActivity: (subjects, window) => geckoTerminal.getTokenActivity(subjects, window),
    getTokenHistory: (subject, range) => geckoTerminal.getTokenHistory(subject, range),
  }
}
