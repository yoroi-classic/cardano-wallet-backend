import type { FastifyInstance } from 'fastify'
import type { ChainProvider } from '../../providers/provider.js'
import { registerAccountRoutes } from './account.js'
import { registerAddressRoutes } from './addresses.js'
import { registerAssetRoutes } from './assets.js'
import { registerChainRoutes } from './chain.js'
import { registerGovernanceRoutes } from './governance.js'
import { registerHealthRoutes } from './health.js'
import { registerPoolRoutes } from './pools.js'
import { registerPriceRoutes } from './price.js'
import { registerStatusRoutes, type StatusInfo } from './status.js'
import { registerTxRoutes } from './tx.js'

/**
 * Every route module registers through this one signature, so the server can iterate.
 *
 * `info` describes the running service (version, network, provider). Most modules do not want it
 * and simply declare two parameters, which is assignable to this and stays honest about what they
 * use.
 */
export type RouteRegistrar = (
  app: FastifyInstance,
  provider: ChainProvider,
  info: StatusInfo,
) => void

/**
 * The route table. A new endpoint group is a new module plus one line here, which keeps
 * concurrent feature branches out of `server.ts` and out of each other's way.
 */
export const routeRegistrars: readonly RouteRegistrar[] = [
  registerHealthRoutes,
  registerStatusRoutes,
  registerChainRoutes,
  registerAccountRoutes,
  registerAddressRoutes,
  registerPoolRoutes,
  registerAssetRoutes,
  registerGovernanceRoutes,
  registerPriceRoutes,
  registerTxRoutes,
]
