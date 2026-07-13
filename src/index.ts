import type { FastifyBaseLogger } from 'fastify'
import { loadConfig } from './config/index.js'
import { createProvider } from './providers/factory.js'
import { buildServer } from './http/server.js'

async function main(): Promise<void> {
  const config = loadConfig()

  // The provider is built before the server, because the routes need it at registration, but the
  // log only exists once the server does. So the retry observer reads the log out of this cell
  // when it fires rather than capturing it now, and the cell is filled in as soon as there is a
  // log to put in it. Nothing can retry before then: a retry only happens inside a request, and
  // no request arrives before there is a server to receive it.
  const log: { current?: FastifyBaseLogger } = {}
  const provider = createProvider(config, {
    onRetry: (event) => log.current?.warn(event, 'retrying an upstream read'),
  })
  const app = buildServer({ provider, logger: { level: config.logLevel } })
  log.current = app.log

  try {
    await app.listen({ host: config.host, port: config.port })
    app.log.info(
      { network: config.network, provider: provider.name },
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
