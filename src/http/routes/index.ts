import type { FastifyInstance } from 'fastify'
import type { NftcdnSigner } from '../../media/nftcdn.js'
import type { ChainProvider } from '../../providers/provider.js'
import { registerAccountRoutes } from './account.js'
import { registerAddressRoutes } from './addresses.js'
import { registerAssetRoutes } from './assets.js'
import { registerChainRoutes } from './chain.js'
import { registerGovernanceRoutes } from './governance.js'
import { registerHealthRoutes } from './health.js'
import { registerMediaRoutes } from './media.js'
import { registerPoolRoutes } from './pools.js'
import { registerStatusRoutes, type StatusInfo } from './status.js'
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
  (app, provider, deps) => registerStatusRoutes(app, provider, deps.info),
  registerChainRoutes,
  registerAccountRoutes,
  registerAddressRoutes,
  registerPoolRoutes,
  registerAssetRoutes,
  (app, _provider, deps) => registerMediaRoutes(app, deps.nftcdn),
  registerGovernanceRoutes,
  registerTxRoutes,
]
