import { createMemoryCache, noCache, type Cache } from '../cache/index.js'
import type { AppConfig } from '../config/index.js'
import { ConfigError } from '../domain/errors.js'
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

function createDriver(config: AppConfig, deps: ProviderDeps): ChainProvider {
  switch (config.provider) {
    case 'koios':
      return createKoiosProvider({
        baseUrl: config.koios.url,
        token: config.koios.token,
        onRetry: deps.onRetry,
      })
    case 'blockfrost':
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
 * Build the active chain provider from config, wrapped in the response cache. Only Koios is
 * wired today; the Blockfrost and Dingo drivers slot in here as they land, behind the same
 * interface, and they inherit the caching because it wraps the interface rather than the driver.
 *
 * The cache is created here rather than inside a driver so there is exactly one of it, and so a
 * unit test that builds a driver directly gets no caching and its upstream call counts mean what
 * they look like.
 */
export function createProvider(config: AppConfig, deps: ProviderDeps = {}): ChainProvider {
  const cache: Cache = config.cacheEnabled ? createMemoryCache() : noCache
  return withCache(createDriver(config, deps), cache)
}
