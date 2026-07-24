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
    case 'blockfrost': {
      // loadConfig refuses to produce a config with PROVIDER=blockfrost and no project id, so
      // reaching here with one absent means a caller built an AppConfig by hand (a test, most
      // likely) rather than through the loader. Trim and re-check the same way loadConfig does: a
      // blank or whitespace-only project id is no credential at all, and letting it through would
      // hand the client an empty `project_id` header rather than failing loudly here.
      const projectId = config.blockfrost.projectId?.trim()
      if (projectId === undefined || projectId.length === 0) {
        throw new ConfigError('BLOCKFROST_PROJECT_ID is required to build a blockfrost provider')
      }
      return createBlockfrostProvider({
        baseUrl: config.blockfrost.url,
        projectId,
        onRetry: deps.onRetry,
      })
    }
    case 'dingo':
      throw new ConfigError(`provider "${config.provider}" is not wired up yet`)
    default: {
      // Exhaustiveness guard: if a new provider is added to the enum, this fails to compile.
      const never: never = config.provider
      throw new ConfigError(`unknown provider: ${String(never)}`)
    }
  }
}

function scopeProviderCache(cache: Cache, config: AppConfig): Cache {
  // Keep noCache's identity: Koios uses that singleton to select its no-cache fast path.
  if (cache === noCache) return noCache

  // A process cache is intentionally shared with price and remote-config reads, and callers can
  // also construct more than one provider against it in tests or migration tooling. Provider and
  // network are therefore part of every chain-data key; a mainnet tip must never satisfy a
  // preprod read, nor a Koios value a Blockfrost read.
  const prefix = `provider:${config.provider}:${config.network}:`
  const key = (value: string): string => `${prefix}${value}`

  return {
    read: (value, policy, load) => cache.read(key(value), policy, load),
    peek: (value) => cache.peek(key(value)),
    set: (value, data, ttlMs) => cache.set(key(value), data, ttlMs),
    get size() {
      return cache.size
    },
    clear: () => cache.clear(),
  }
}

/**
 * Build the active chain provider from config, wrapped in the response cache. Koios and
 * Blockfrost are wired today; the Dingo driver slots in here as it lands, behind the same
 * interface, and it inherits the caching because it wraps the interface rather than the driver.
 *
 * The application injects its one process cache so provider, price, and remote-config reads share
 * the same bounded store and one CACHE_ENABLED decision. Standalone callers retain the configured
 * fallback: a private memory cache when enabled, or noCache when disabled. A unit test that builds
 * a driver directly still gets no caching and its upstream call counts mean what they look like.
 *
 * The same provider-scoped view goes to both the decorator and the driver, and it matters that it
 * is the same one. The decorator caches the tip; the pool module needs the current epoch to key
 * its ranking on, and reads it through the same key. Two caches would mean two tips, two upstream
 * reads, and at an epoch boundary two different opinions about which epoch it is.
 */
export function createProvider(config: AppConfig, deps: ProviderDeps = {}): ChainProvider {
  const processCache: Cache = deps.cache ?? (config.cacheEnabled ? createMemoryCache() : noCache)
  const cache = scopeProviderCache(processCache, config)
  return withCache(createDriver(config, deps, cache), cache)
}
