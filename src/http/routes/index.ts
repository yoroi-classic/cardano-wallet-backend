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
import { registerTxRoutes } from './tx.js'

/**
 * Everything a route module might need beyond the chain provider.
 *
 * Optional, because these are optional upstreams: a deployment with no NFTCDN credential still
 * serves every chain read, and only the media routes degrade (to a 503 that says why).
 */
export interface RouteDeps {
  /** Signs NFTCDN media URLs. Absent when the deployment has no NFTCDN credential. */
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
  registerChainRoutes,
  registerAccountRoutes,
  registerAddressRoutes,
  registerPoolRoutes,
  registerAssetRoutes,
  (app, _provider, deps) => registerMediaRoutes(app, deps.nftcdn),
  registerGovernanceRoutes,
  registerTxRoutes,
]
