import type { FastifyInstance } from 'fastify'
import type { NftcdnSigner } from '../../media/nftcdn.js'
import type { PriceProvider } from '../../prices/index.js'
import type { RemoteConfig } from '../../remote-config/index.js'
import type { ChainProvider } from '../../providers/provider.js'
import type { StatusInfo } from '../../domain/types/status.js'
import { registerAccountRoutes } from './account.js'
import { registerAddressRoutes } from './addresses.js'
import { registerAssetRoutes } from './assets.js'
import { registerChainRoutes } from './chain.js'
import { registerConfigRoutes } from './config.js'
import { registerGovernanceRoutes } from './governance.js'
import { registerHealthRoutes } from './health.js'
import { registerMediaRoutes } from './media.js'
import { registerOpenapiRoutes } from './openapi.js'
import { registerPoolRoutes } from './pools.js'
import { registerPriceRoutes } from './price.js'
import { registerStatusRoutes } from './status.js'
import { registerTxRoutes } from './tx.js'

/**
 * Everything a route module might need beyond the chain provider.
 *
 * One bag rather than a growing list of positional parameters, and that is not a style
 * preference. Two branches independently added a *third* argument to the registrar signature (one
 * passed the service info for `/v1/status`, the other an NFTCDN signer for the media routes), and
 * they collided in a way git could not resolve, because each was correct and they disagreed. A
 * bag makes the next such addition a new optional field that nothing else has to notice.
 */
export interface RouteDeps {
  /** Version, network and provider, for `/v1/status`. */
  info: StatusInfo
  /**
   * Signs NFTCDN media URLs. Absent when the deployment has no NFTCDN credential, in which case
   * every chain read still works and only the media routes degrade, to a 503 that says why.
   */
  nftcdn?: NftcdnSigner
  /**
   * Remote config for the clients. Absent when the deployment does not serve it, in which case
   * /v1/config answers 503 and everything else works.
   */
  remoteConfig?: RemoteConfig
  /**
   * Price and market data (CoinGecko + GeckoTerminal). Absent means every /v1/price/* route falls
   * back to the 501 it always answered before a provider existed; see http/routes/price.ts. Unlike
   * NFTCDN and remote config, a real deployment always has one, since neither upstream needs a
   * credential at the free tier (see src/index.ts's main()).
   */
  priceProvider?: PriceProvider
}

/**
 * Every route module registers through this one signature, so the server can iterate.
 *
 * Most modules want only the provider and declare two parameters, which is assignable to this and
 * keeps them honest about what they actually use.
 */
export type RouteRegistrar = (
  app: FastifyInstance,
  provider: ChainProvider,
  deps: RouteDeps,
) => void

/**
 * The route table. A new endpoint group is a new module plus one line here, which keeps
 * concurrent feature branches out of `server.ts` and out of each other's way.
 */
export const routeRegistrars: readonly RouteRegistrar[] = [
  registerHealthRoutes,
  registerOpenapiRoutes,
  (app, provider, deps) => registerStatusRoutes(app, provider, deps.info),
  registerChainRoutes,
  (app, provider, deps) => registerAccountRoutes(app, provider, deps.info.network),
  registerAddressRoutes,
  registerPoolRoutes,
  registerAssetRoutes,
  (app, _provider, deps) => registerMediaRoutes(app, deps.nftcdn),
  (app, _provider, deps) => registerConfigRoutes(app, deps.remoteConfig),
  registerGovernanceRoutes,
  (app, _provider, deps) => registerPriceRoutes(app, deps.priceProvider),
  registerTxRoutes,
]
