import type { FastifyInstance } from 'fastify'
import type { ChainProvider } from '../../providers/provider.js'

/**
 * Chain-level reads. Handlers stay thin: they call the provider and return the
 * normalized shape. Any provider error bubbles up to the server's error handler,
 * which maps it to a stable status code and body.
 */
export function registerChainRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.get('/v1/chain/tip', async () => provider.getTip())
  app.get('/v1/chain/protocol-params', async () => provider.getProtocolParams())
}
