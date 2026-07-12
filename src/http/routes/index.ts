import type { FastifyInstance } from 'fastify'
import type { ChainProvider } from '../../providers/provider.js'
import { registerAccountRoutes } from './account.js'
import { registerAddressRoutes } from './addresses.js'
import { registerChainRoutes } from './chain.js'
import { registerHealthRoutes } from './health.js'
import { registerPoolRoutes } from './pools.js'
import { registerTxRoutes } from './tx.js'

/** Every route module registers through this one signature, so the server can iterate. */
export type RouteRegistrar = (app: FastifyInstance, provider: ChainProvider) => void

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
  registerTxRoutes,
]
