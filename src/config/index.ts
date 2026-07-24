import { z } from 'zod'
import { ConfigError } from '../domain/errors.js'
import { DEFAULT_CONFIG_URL } from '../remote-config/index.js'

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
  /**
   * NFTCDN, for native-asset media. Optional: a deployment without it serves every chain read and
   * only the media routes degrade, to a 503 that says why.
   */
  nftcdn?: {
    subdomain: string
    secretKeyBase64: string
  }
  /**
   * Where the client remote config is published. Defaults to our own fork.
   *
   * Set it to an empty string to turn the endpoint off, which is the only way to turn it off: the
   * default is on, because a wallet that cannot read its config is a wallet that will not finish
   * starting, and defaulting an availability feature to "off" is how outages happen quietly.
   */
  configUrl?: string
  koios: {
    url: string
    token?: string
  }
  blockfrost: {
    url: string
    /** Blockfrost's auth token. Required only when `provider` is `'blockfrost'`. */
    projectId?: string
  }
  /**
   * Free "Demo" tier CoinGecko API key, for a higher rate limit than the anonymous tier. Absent
   * works fine: CoinGecko's public endpoints answer without one, just at a lower limit, and price
   * is otherwise on by default (see main() in src/index.ts) since neither upstream it uses needs
   * a credential to work at all.
   */
  coingeckoApiKey?: string
}

const DEFAULT_KOIOS_URL: Record<Network, string> = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
}

// Blockfrost's own hosted endpoints, one project per network (see the `servers` block of
// Blockfrost's OpenAPI spec).
const DEFAULT_BLOCKFROST_URL: Record<Network, string> = {
  mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
  preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
  preview: 'https://cardano-preview.blockfrost.io/api/v0',
}

function isSupportedConfigUrl(value: string): boolean {
  if (value === '') return true
  if (value !== value.trim() || !/^https?:\/\//i.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
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
  BLOCKFROST_URL: z.string().url().optional(),
  // Required only when PROVIDER=blockfrost is actually selected; checked below rather than here
  // so an unrelated deployment (PROVIDER=koios) is never blocked by a credential it doesn't use.
  BLOCKFROST_PROJECT_ID: z.string().optional(),
  // NFTCDN. The subdomain is the network name on preprod/preview and an account-specific one on
  // mainnet; the key is base64, exactly as their dashboard gives it. Both or neither: a half
  // configuration is a typo, and it should fail at startup rather than 500 on the first image.
  NFTCDN_SUBDOMAIN: z.string().trim().min(1).optional(),
  // Check trimmed content without transforming the value: this is signing material, so validation
  // must not silently rewrite the operator's secret.
  NFTCDN_KEY: z
    .string()
    .refine((value) => value.trim().length > 0, 'must contain a non-whitespace value')
    .optional(),
  // Client remote config. Exactly "" disables it; every other value must be fetchable by Node.
  CONFIG_URL: z
    .string()
    .refine(isSupportedConfigUrl, 'must be empty or an absolute, unpadded HTTP(S) URL')
    .default(DEFAULT_CONFIG_URL),
  // Optional: raises the CoinGecko rate limit above the anonymous tier. Unset works fine.
  COINGECKO_API_KEY: z.string().optional(),
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
  // Trim before the presence check: a whitespace-only value is not a credential, it is a blank one
  // dressed up, and letting it through would start up cleanly and then send an empty `project_id`
  // header on every read. Store the trimmed value so nothing downstream re-pads it.
  const trimmedBlockfrostProjectId = e.BLOCKFROST_PROJECT_ID?.trim()
  const blockfrostProjectId =
    trimmedBlockfrostProjectId && trimmedBlockfrostProjectId.length > 0
      ? trimmedBlockfrostProjectId
      : undefined

  // Both or neither. Half of an NFTCDN configuration is a typo or a half-finished deploy, and the
  // failure it produces without this check is a 500 on the first image somebody looks at, which is
  // a bad place to learn about it. Fail at startup, where an operator is watching.
  if ((e.NFTCDN_SUBDOMAIN === undefined) !== (e.NFTCDN_KEY === undefined)) {
    throw new ConfigError(
      'NFTCDN_SUBDOMAIN and NFTCDN_KEY must be set together, or not at all. Set neither and the ' +
        'media routes answer 503 while everything else works.',
    )
  }

  // A deployment that selects blockfrost with no project id is a typo or a half-finished deploy,
  // exactly like the NFTCDN case above, and the failure it produces without this check is a 500
  // on the first chain read rather than at startup where an operator is watching. Unlike NFTCDN,
  // there is no graceful degradation available here: a chain-data provider is not optional, so
  // this fails loudly rather than falling back to a 503 on some routes.
  if (e.PROVIDER === 'blockfrost' && blockfrostProjectId === undefined) {
    throw new ConfigError(
      'BLOCKFROST_PROJECT_ID is required when PROVIDER=blockfrost. Get one from ' +
        'https://blockfrost.io.',
    )
  }

  const nftcdn =
    e.NFTCDN_SUBDOMAIN !== undefined && e.NFTCDN_KEY !== undefined
      ? { subdomain: e.NFTCDN_SUBDOMAIN, secretKeyBase64: e.NFTCDN_KEY }
      : undefined

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
    ...(nftcdn === undefined ? {} : { nftcdn }),
    ...(e.CONFIG_URL === '' ? {} : { configUrl: e.CONFIG_URL }),
    koios: {
      url: e.KOIOS_URL ?? DEFAULT_KOIOS_URL[e.NETWORK],
      token,
    },
    blockfrost: {
      url: e.BLOCKFROST_URL ?? DEFAULT_BLOCKFROST_URL[e.NETWORK],
      projectId: blockfrostProjectId,
    },
    ...(e.COINGECKO_API_KEY && e.COINGECKO_API_KEY.length > 0
      ? { coingeckoApiKey: e.COINGECKO_API_KEY }
      : {}),
  }
}
