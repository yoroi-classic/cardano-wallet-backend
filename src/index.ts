import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { createMemoryCache, noCache, type Cache } from './cache/index.js'
import { loadConfig } from './config/index.js'
import { createNftcdnSigner } from './media/nftcdn.js'
import { createRemoteConfig } from './remote-config/index.js'
import { createProvider } from './providers/factory.js'
import { buildServer } from './http/server.js'
import { version } from './version.js'

/** Signals an orchestrator sends to ask a container to stop. */
const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const

/** How long in-flight requests get to finish before the process leaves anyway. */
const SHUTDOWN_GRACE_MS = 15_000

/**
 * Stop serving without dropping the requests already in flight.
 *
 * A rolling deploy sends SIGTERM and then removes the container. Without this, Node's default is
 * to exit immediately, so every request being served at that moment dies on the wire: a wallet
 * mid-balance-refresh gets a connection reset, and if it happened to be a submit, the caller has
 * no idea whether the transaction went out. Closing the server first lets those finish and stops
 * new connections being accepted.
 *
 * The timer is the backstop. If something is wedged, the deploy must still complete, so we leave
 * anyway rather than hanging until the orchestrator SIGKILLs us at some less predictable moment.
 */
function stopGracefully(app: FastifyInstance): void {
  let stopping = false

  for (const signal of STOP_SIGNALS) {
    process.on(signal, () => {
      // A second signal during shutdown means someone is impatient. Honour that.
      if (stopping) {
        app.log.warn({ signal }, 'second stop signal, exiting now')
        process.exit(1)
      }
      stopping = true
      app.log.info({ signal }, 'stopping: draining in-flight requests')

      const backstop = setTimeout(() => {
        app.log.error({ graceMs: SHUTDOWN_GRACE_MS }, 'shutdown timed out, exiting anyway')
        process.exit(1)
      }, SHUTDOWN_GRACE_MS)
      // Don't let the backstop itself hold the event loop open once we are done.
      backstop.unref()

      app
        .close()
        .then(() => {
          app.log.info('stopped cleanly')
          process.exit(0)
        })
        .catch((err: unknown) => {
          app.log.error({ err }, 'error while stopping')
          process.exit(1)
        })
    })
  }
}

async function main(): Promise<void> {
  const config = loadConfig()

  // The provider is built before the server, because the routes need it at registration, but the
  // log only exists once the server does. So the retry observer reads the log out of this cell
  // when it fires rather than capturing it now, and the cell is filled in as soon as there is a
  // log to put in it. Nothing can retry before then: a retry only happens inside a request, and
  // no request arrives before there is a server to receive it.
  const log: { current?: FastifyBaseLogger } = {}

  // One cache for the process, shared by the chain provider and the remote config. Built here so
  // there is a single place that decides whether caching is on, and a single place that owns it.
  const cache: Cache = config.cacheEnabled ? createMemoryCache() : noCache

  const provider = createProvider(config, {
    onRetry: (event) => log.current?.warn(event, 'retrying an upstream read'),
    cache,
  })

  // Optional upstream: without it, the media routes answer 503 and everything else works.
  const nftcdn = config.nftcdn === undefined ? undefined : createNftcdnSigner(config.nftcdn)

  // Shares the provider's cache, so a config fetch is one request every five minutes rather than
  // one per wallet launch, and survives a GitHub outage for a day. See src/remote-config.
  const remoteConfig =
    config.configUrl === undefined
      ? undefined
      : createRemoteConfig({ url: config.configUrl, cache })

  const app = await buildServer({
    provider,
    logger: { level: config.logLevel },
    info: { version, network: config.network, provider: provider.name },
    ...(nftcdn === undefined ? {} : { nftcdn }),
    ...(remoteConfig === undefined ? {} : { remoteConfig }),
    corsOrigins: config.corsOrigins,
    rateLimit: config.rateLimit,
  })
  log.current = app.log

  stopGracefully(app)

  try {
    await app.listen({ host: config.host, port: config.port })
    app.log.info(
      {
        version,
        network: config.network,
        provider: provider.name,
        cache: config.cacheEnabled,
        rateLimit: config.rateLimit ?? 'disabled',
        // The subdomain, never the key. This line goes to a log that outlives the process.
        media: config.nftcdn === undefined ? 'disabled' : `nftcdn:${config.nftcdn.subdomain}`,
        remoteConfig: config.configUrl ?? 'disabled',
      },
      `cardano-wallet-backend listening on ${config.host}:${config.port}`,
    )
  } catch (err) {
    // If anything fails once the socket is open, close it so a broken startup can't
    // leave a listening-but-unhealthy zombie process holding the event loop open.
    await app.close().catch(() => {})
    throw err
  }
}

main().catch((err) => {
  console.error('failed to start cardano-wallet-backend', err)
  // Non-zero exit, but let Node flush logs and drain naturally. main() has already
  // closed the server on failure, so nothing keeps the process alive.
  process.exitCode = 1
})
