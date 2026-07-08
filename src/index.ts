import { loadConfig } from './config/index.js'
import { createProvider } from './providers/factory.js'
import { buildServer } from './http/server.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const provider = createProvider(config)
  const app = buildServer({ provider, logger: { level: config.logLevel } })

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
