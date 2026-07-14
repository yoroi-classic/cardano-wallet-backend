import { z } from 'zod'
import { ConfigError } from '../domain/errors.js'

export const NETWORKS = ['mainnet', 'preprod', 'preview'] as const
export type Network = (typeof NETWORKS)[number]

export const PROVIDERS = ['koios', 'blockfrost', 'dingo'] as const
export type ProviderName = (typeof PROVIDERS)[number]

export interface AppConfig {
  network: Network
  host: string
  port: number
  logLevel: string
  provider: ProviderName
  /** Cache the chain-wide reads. On by default; an escape hatch for debugging upstream. */
  cacheEnabled: boolean
  /** Browser origins allowed to call the API. `'*'` reflects any. See BuildServerOptions. */
  corsOrigins: string[] | '*'
  /** Anonymous free-tier limit, per client IP. `undefined` disables it. */
  rateLimit?: { max: number; windowMs: number }
  koios: {
    url: string
    token?: string
  }
}

const DEFAULT_KOIOS_URL: Record<Network, string> = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
}

const schema = z.object({
  NETWORK: z.enum(NETWORKS).default('preprod'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(3010),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PROVIDER: z.enum(PROVIDERS).default('koios'),
  // Only an explicit "false" turns caching off. Anything else, including an unset variable,
  // leaves it on: a typo in an env var must not silently multiply our upstream load.
  CACHE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Comma-separated origin list, or "*" for any. The browser extension calls from an opaque
  // `chrome-extension://<id>` origin that changes per build, so an allowlist is impractical
  // until we pin an extension id, and CORS is not a security control here anyway (see
  // BuildServerOptions.corsOrigins).
  CORS_ORIGINS: z.string().default('*'),
  // Anonymous free tier. 0 disables the limiter, which is only correct on a private deployment.
  RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  KOIOS_URL: z.string().url().optional(),
  KOIOS_TOKEN: z.string().optional(),
})

function parseCorsOrigins(raw: string): string[] | '*' {
  const trimmed = raw.trim()
  if (trimmed === '*' || trimmed === '') return '*'
  return trimmed
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

/**
 * Parse and validate configuration from an environment map. Throws ConfigError with
 * the offending fields rather than letting a bad env crash deep in a request.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    throw new ConfigError('invalid configuration', parsed.error.issues)
  }
  const e = parsed.data
  const token = e.KOIOS_TOKEN && e.KOIOS_TOKEN.length > 0 ? e.KOIOS_TOKEN : undefined
  return {
    network: e.NETWORK,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    provider: e.PROVIDER,
    cacheEnabled: e.CACHE_ENABLED,
    corsOrigins: parseCorsOrigins(e.CORS_ORIGINS),
    // A max of 0 means "no limiter at all", which is a deliberate choice for a private
    // deployment and a foot-gun on a public one. It is off only when someone asks for it.
    rateLimit:
      e.RATE_LIMIT_MAX > 0
        ? { max: e.RATE_LIMIT_MAX, windowMs: e.RATE_LIMIT_WINDOW_MS }
        : undefined,
    koios: {
      url: e.KOIOS_URL ?? DEFAULT_KOIOS_URL[e.NETWORK],
      token,
    },
  }
}
