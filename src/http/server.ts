import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify'
import { isAppError } from '../domain/errors.js'
import type { ChainProvider } from '../providers/provider.js'
import { routeRegistrars, type RouteDeps } from './routes/index.js'

export interface BuildServerOptions {
  provider: ChainProvider
  /** Optional upstreams beyond the chain provider. Absent ones degrade, they do not break. */
  deps?: RouteDeps
  /** Fastify logger option. False (default) keeps tests quiet. */
  logger?: boolean | { level: string }
}

/**
 * Build the Fastify app. Kept as a factory (no side effects, no listen) so tests
 * can drive it with `app.inject` and never open a socket.
 */
export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false })

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
      return
    }
    // Anything not modeled is a bug. Log it, but never leak internals to the caller.
    ;(request.log as FastifyBaseLogger).error({ err: error }, 'unhandled error')
    reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal server error' } })
  })

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `route ${request.method} ${request.url} not found` },
    })
  })

  const deps = opts.deps ?? {}
  for (const register of routeRegistrars) {
    register(app, opts.provider, deps)
  }

  return app
}
