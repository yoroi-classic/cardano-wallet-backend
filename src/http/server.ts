import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify'
import { isAppError } from '../domain/errors.js'
import type { StatusInfo } from '../domain/types/status.js'
import type { ChainProvider } from '../providers/provider.js'
import type { NftcdnSigner } from '../media/nftcdn.js'
import type { PriceProvider } from '../prices/index.js'
import type { RemoteConfig } from '../remote-config/index.js'
import { scrubMessage, serializeRequest } from './logging.js'
import { routeRegistrars, type RouteDeps } from './routes/index.js'

export interface RateLimitOptions {
  /** Requests allowed per window, per client. */
  max: number
  /** Window length, in milliseconds. */
  windowMs: number
}

export interface BuildServerOptions {
  provider: ChainProvider
  /** Version, network and provider, reported by `/v1/status`. */
  info?: StatusInfo
  /**
   * Signs NFTCDN media URLs. Absent when the deployment has no NFTCDN credential, in which case
   * the media routes answer 503 and every other endpoint works.
   */
  nftcdn?: NftcdnSigner
  /** Remote config for the clients. Absent means /v1/config answers 503. */
  remoteConfig?: RemoteConfig
  /**
   * Price and market data. Absent means every /v1/price/* route answers the 501 it always has;
   * see RouteDeps.priceProvider.
   */
  priceProvider?: PriceProvider
  /** Fastify logger option. False (default) keeps tests quiet. */
  logger?: boolean | { level: string }
  /**
   * Origins allowed to call this from a browser. `'*'` (the default) sends a wildcard, which any
   * origin accepts; a list sends back only the requesting origin when it is on the list.
   *
   * Worth being clear about what this is and is not. The API is public, unauthenticated and
   * read-only, so CORS is not protecting anything here: a locked-down origin list would break the
   * browser extension and the web build, which are the clients we are trying to serve, while an
   * attacker simply calls the API from a server, where CORS does not apply at all. It is here
   * because browsers require the headers, not as a security control.
   *
   * When account tokens arrive, credentialed requests will need a real allowlist, and that is the
   * moment to revisit this rather than now.
   */
  corsOrigins?: string[] | '*'
  /** Anonymous free-tier limit. Omit to disable (tests, and trusted private deployments). */
  rateLimit?: RateLimitOptions
  /**
   * Exact proxy IPs/CIDRs allowed to supply `X-Forwarded-For`. Empty/absent is the secure direct
   * deployment default: forwarded addresses are ignored and the socket peer owns the rate bucket.
   */
  trustedProxies?: string[]
}

const DEFAULT_INFO: StatusInfo = { version: '0.0.0', network: 'unknown', provider: 'unknown' }

/**
 * Build the Fastify app. Kept as a factory (no side effects, no listen) so tests can drive it
 * with `app.inject` and never open a socket.
 *
 * Async, and it has to be. A Fastify plugin adds its hooks when it *loads*, and a route only runs
 * the hooks that exist at the moment it is registered. Registering the plugins without awaiting
 * them defers loading to `ready()`, by which point the routes are already built, and they quietly
 * come out with no hooks attached: the rate limiter is present, configured, and does nothing.
 *
 * That is not a hypothetical. It is what the first version of this did, and the limit test caught
 * it (4 requests against a max of 3 all returned 200). Awaiting is what makes the plugins real.
 */
export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger === undefined || opts.logger === false
        ? false
        : {
            ...(opts.logger === true ? {} : opts.logger),
            // The privacy posture of this whole service rests on this one line. See ./logging.ts:
            // Fastify's default request log writes the stake key (it is in the URL) on the same
            // line as the client's IP, which is exactly the link a wallet backend must not keep.
            serializers: { req: serializeRequest },
          },
    // Never trust forwarded addresses just because they are present. A direct caller controls
    // those headers and could rotate them to evade the per-IP limiter. Fastify walks the chain
    // only when the socket peer matches this explicit address/CIDR allowlist.
    trustProxy:
      opts.trustedProxies === undefined || opts.trustedProxies.length === 0
        ? false
        : opts.trustedProxies,
  })

  await app.register(cors, {
    origin: opts.corsOrigins ?? '*',
    methods: ['GET', 'POST'],
    // No cookies and no credentialed requests yet, and `credentials: true` alongside a wildcard
    // origin is a spec violation in any case. When tokens land, this and the origin list are one
    // decision, not two.
    credentials: false,
  })

  if (opts.rateLimit) {
    await app.register(rateLimit, {
      max: opts.rateLimit.max,
      timeWindow: opts.rateLimit.windowMs,
      // The limiter holds a counter per client IP in memory. That is not a log: it is transient,
      // never written to disk, and never joined to what was asked for. See ./logging.ts.
      //
      // /health is exempt, because an instance that rate-limits its own orchestrator's liveness
      // probe gets declared dead, which is a fine way to turn a traffic spike into an outage.
      //
      // A function, not the array form: the array is matched against the *key* (the client IP),
      // so `allowList: ['/health']` reads like a route exemption and is in fact an exemption for a
      // client whose IP is the string "/health", which is to say nobody.
      allowList: (request) => request.url === '/health',
      // Deliberately no errorResponseBuilder. The plugin raises the 429 as an error, so the error
      // handler below sees it anyway, and having both build a body means two places disagree
      // about the response envelope. One owner. The plugin's own message already tells the caller
      // how long to wait, which is the part worth keeping.
    })
  }

  app.setErrorHandler((error, request, reply) => {
    // Our own errors name the upstream path that failed, and some upstream paths have to carry a
    // wallet identifier (see scrubMessage). The endpoint is the useful part of the message and it
    // survives; the identifier does not need to travel back out in a body.
    if (isAppError(error)) {
      reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: scrubMessage(error.message) } })
      return
    }

    // Errors raised by Fastify and its plugins rather than by us: a 429 from the rate limiter, a
    // 400 for a body that claimed to be JSON and was not. These already know what they are, and
    // reporting them as internal server errors would be a lie that also hides a caller's own
    // mistake from them. Only the message crosses over, never the stack or the internals.
    const { statusCode, message } = error as { statusCode?: number; message?: string }
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({
        error: {
          code: statusCode === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST',
          message: message === undefined ? 'bad request' : scrubMessage(message),
        },
      })
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

  // One bag, so the next optional upstream is a new field rather than a fourth argument that two
  // branches will independently add and then disagree about.
  const deps: RouteDeps = {
    info: opts.info ?? DEFAULT_INFO,
    ...(opts.nftcdn === undefined ? {} : { nftcdn: opts.nftcdn }),
    ...(opts.remoteConfig === undefined ? {} : { remoteConfig: opts.remoteConfig }),
    ...(opts.priceProvider === undefined ? {} : { priceProvider: opts.priceProvider }),
  }
  for (const register of routeRegistrars) {
    register(app, opts.provider, deps)
  }

  return app
}
