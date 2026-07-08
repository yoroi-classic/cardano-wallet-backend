import { loadConfig } from './config/index.js'
import { createProvider } from './providers/factory.js'
import { buildServer } from './http/server.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const provider = createProvider(config)
  const app = buildServer({ provider, logger: { level: config.logLevel } })

  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    { network: config.network, provider: provider.name },
    `cardano-wallet-backend listening on ${config.host}:${config.port}`,
  )
}

main().catch((err) => {
  console.error('failed to start cardano-wallet-backend', err)
  // Set a non-zero exit code but let Node flush logs and finish teardown naturally
  // rather than forcing an immediate exit.
  process.exitCode = 1
})
