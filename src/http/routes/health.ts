import type { FastifyInstance } from 'fastify'

/** Liveness endpoint. Cheap, no upstream calls, used by the CI healthcheck and orchestrators. */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async () => ({ status: 'ok', service: 'cardano-wallet-backend' }))
}
