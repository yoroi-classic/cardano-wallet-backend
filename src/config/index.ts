import { z } from 'zod'
import { isIP } from 'node:net'
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
  /** Exact proxy IPs/CIDRs allowed to supply the client address. Empty means direct traffic. */
  trustedProxies: string[]
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

function isValidNftcdnKey(value: string): boolean {
  const key = value.trim()
  // NFTCDN supplies standard (not URL-safe) padded base64. Reject malformed
  // input instead of letting Buffer silently discard invalid characters.
  if (key.length === 0 || key.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    return false
  }
  const decoded = Buffer.from(key, 'base64')
  return decoded.length > 0 && decoded.some((byte) => byte !== 0)
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
  TRUST_PROXY: z.string().default(''),
  KOIOS_URL: z.string().url().optional(),
  KOIOS_TOKEN: z.string().optional(),
  BLOCKFROST_URL: z.string().url().optional(),
  // Required only when PROVIDER=blockfrost is actually selected; checked below rather than here
  // so an unrelated deployment (PROVIDER=koios) is never blocked by a credential it doesn't use.
  BLOCKFROST_PROJECT_ID: z.string().optional(),
  // NFTCDN. The subdomain is the network name on preprod/preview and an account-specific one on
  // mainnet; the key is base64, exactly as their dashboard gives it. Both or neither: a half
  // configuration is a typo, and it should fail at startup rather than 500 on the first image.
  NFTCDN_SUBDOMAIN: z
    .string()
    .trim()
    .min(1)
    .regex(/^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'must be a DNS hostname label')
    .optional(),
  // Check trimmed content without transforming the value: this is signing material, so validation
  // must not silently rewrite the operator's secret.
  NFTCDN_KEY: z
    .string()
    .refine(isValidNftcdnKey, 'must contain a non-empty standard base64-encoded key')
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
 * The shortest prefix a trusted-proxy entry may carry, in either family.
 *
 * This list names the hosts allowed to rewrite the client IP, so it should be a few addresses or a
 * private range. The widest legitimate shapes, `10.0.0.0/8` and `fd00::/8`, are both /8. Anything
 * shorter is not an allowlist, it is a way to trust the internet, and it fails silently: nothing
 * errors, the per-IP limiter simply becomes one shared bucket for every caller.
 *
 * Rejecting only /0 was not enough, because one range that wide can be spelled as two that are
 * not. `0.0.0.0/1,128.0.0.0/1` reads like two ordinary entries and between them covers every IPv4
 * address.
 */
const MIN_TRUSTED_PREFIX = 8

/** The IPv4-mapped IPv6 block, `::ffff:0:0/96`, and the bits a prefix spends reaching it. */
const IPV4_MAPPED_PREFIX = '::ffff:'
const IPV4_MAPPED_PREFIX_BITS = 96

/**
 * An IPv4-mapped IPv6 address in its plain IPv4 form, or undefined if it is not mapped.
 *
 * WHATWG URL parsing is the standard library's only IPv6 canonicalizer: it compresses and
 * lowercases, so `::ffff:0.0.0.0`, `0:0:0:0:0:ffff:0:0` and `::ffff:0:0` all arrive here as one
 * string and a single test recognizes the block. Matching the written form instead would catch
 * whichever spelling someone used and miss the two that mean the same thing.
 */
function mappedIpv4(address: string): string | undefined {
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1)
  if (!canonical.startsWith(IPV4_MAPPED_PREFIX)) return undefined
  const groups = canonical.slice(IPV4_MAPPED_PREFIX.length).split(':')
  if (groups.length !== 2) return undefined
  const [high, low] = groups.map((group) => Number.parseInt(group, 16))
  if (high === undefined || low === undefined || Number.isNaN(high) || Number.isNaN(low)) {
    return undefined
  }
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.')
}

function parseTrustedProxies(raw: string): string[] {
  const proxies = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const normalized = proxies.map((proxy) => {
    const reject = (): never => {
      throw new ConfigError(
        `invalid TRUST_PROXY entry "${proxy}"; use comma-separated IP addresses or CIDR ranges, ` +
          `none wider than a /${MIN_TRUSTED_PREFIX}`,
      )
    }

    const [rawAddress = '', rawPrefix, extra] = proxy.split('/')
    if (extra !== undefined) return reject()

    let address = rawAddress
    const family = isIP(address)
    if (family === 0) return reject()

    let prefix: number | undefined
    if (rawPrefix !== undefined) {
      if (!/^[0-9]+$/.test(rawPrefix)) return reject()
      prefix = Number(rawPrefix)
      if (!Number.isSafeInteger(prefix) || prefix > (family === 4 ? 32 : 128)) return reject()
    }

    // A mapped entry is an IPv4 range wearing an IPv6 hat, and its prefix counts from the front of
    // all 128 bits. Left as written, `::ffff:0.0.0.0/96` looks like a narrow /96 and passes any
    // width rule while meaning every IPv4 address. Expressed as the IPv4 range it actually is, one
    // rule covers both spellings.
    const mapped = family === 6 ? mappedIpv4(address) : undefined
    if (mapped !== undefined) {
      if (prefix !== undefined) {
        if (prefix < IPV4_MAPPED_PREFIX_BITS) return reject()
        // Already checked against the IPv6 maximum of 128, so this lands inside 0..32.
        prefix -= IPV4_MAPPED_PREFIX_BITS
      }
      address = mapped
    }

    if (prefix !== undefined && prefix < MIN_TRUSTED_PREFIX) return reject()

    return prefix === undefined ? address : `${address}/${prefix}`
  })

  return [...new Set(normalized)]
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
    trustedProxies: parseTrustedProxies(e.TRUST_PROXY),
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
