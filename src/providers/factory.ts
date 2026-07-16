import { createMemoryCache, noCache, type Cache } from '../cache/index.js'
import type { AppConfig } from '../config/index.js'
import { ConfigError } from '../domain/errors.js'
import { createBlockfrostProvider } from './blockfrost/index.js'
import { withCache } from './cached.js'
import { createKoiosProvider, type RetryEvent } from './koios/index.js'
import type { ChainProvider } from './provider.js'

/** Cross-cutting dependencies a provider needs but should not construct for itself. */
export interface ProviderDeps {
  /** Called whenever an upstream read is retried, so the app can log it. */
  onRetry?: (event: RetryEvent) => void
  /**
   * The process cache. Passed in rather than built here so the *same* one is shared with
   * everything else that caches (the remote config does), and so there is exactly one place that
   * decides whether caching is on at all.
   */
  cache?: Cache
}

function createDriver(config: AppConfig, deps: ProviderDeps, cache: Cache): ChainProvider {
  switch (config.provider) {
    case 'koios':
      return createKoiosProvider({
        baseUrl: config.koios.url,
        token: config.koios.token,
        onRetry: deps.onRetry,
        cache,
      })
    case 'blockfrost':
      // loadConfig refuses to produce a config with PROVIDER=blockfrost and no project id, so
      // reaching here with one absent means a caller built an AppConfig by hand (a test, most
      // likely) rather than through the loader. Fail the same way rather than handing the
      // client a `project_id: undefined` header.
      if (config.blockfrost.projectId === undefined) {
        throw new ConfigError('BLOCKFROST_PROJECT_ID is required to build a blockfrost provider')
      }
      return createBlockfrostProvider({
        baseUrl: config.blockfrost.url,
        projectId: config.blockfrost.projectId,
        onRetry: deps.onRetry,
      })
    case 'dingo':
      throw new ConfigError(`provider "${config.provider}" is not wired up yet`)
    default: {
      // Exhaustiveness guard: if a new provider is added to the enum, this fails to compile.
      const never: never = config.provider
      throw new ConfigError(`unknown provider: ${String(never)}`)
    }
  }
}

/**
 * Build the active chain provider from config, wrapped in the response cache. Koios and
 * Blockfrost are wired today; the Dingo driver slots in here as it lands, behind the same
 * interface, and it inherits the caching because it wraps the interface rather than the driver.
 *
 * The cache is created here so there is exactly **one** of it, and so a unit test that builds a
 * driver directly gets no caching and its upstream call counts mean what they look like.
 *
 * The same instance goes to both the decorator and the driver, and it matters that it is the same
 * one. The decorator caches the tip; the pool module needs the current epoch to key its ranking
 * on, and reads it through the same key. Two caches would mean two tips, two upstream reads, and
 * at an epoch boundary two different opinions about which epoch it is.
 */
export function createProvider(config: AppConfig, deps: ProviderDeps = {}): ChainProvider {
  const cache: Cache = config.cacheEnabled ? createMemoryCache() : noCache
  return withCache(createDriver(config, deps, cache), cache)
}
