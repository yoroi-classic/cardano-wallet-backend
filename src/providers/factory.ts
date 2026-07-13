import type { AppConfig } from '../config/index.js'
import { ConfigError } from '../domain/errors.js'
import { createKoiosProvider, type RetryEvent } from './koios/index.js'
import type { ChainProvider } from './provider.js'

/** Cross-cutting dependencies a provider needs but should not construct for itself. */
export interface ProviderDeps {
  /** Called whenever an upstream read is retried, so the app can log it. */
  onRetry?: (event: RetryEvent) => void
}

/**
 * Build the active chain provider from config. Only Koios is wired today; the
 * Blockfrost and Dingo drivers slot in here as they land, behind the same interface.
 */
export function createProvider(config: AppConfig, deps: ProviderDeps = {}): ChainProvider {
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
