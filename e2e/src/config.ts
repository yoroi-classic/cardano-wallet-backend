// Load a local .env file if present (Node 22 built-in) so config can come from a file
// rather than only inline env vars.
try {
  process.loadEnvFile()
} catch (err) {
  // A missing .env is expected (rely on the ambient env). Surface anything else, e.g. a
  // permission or parse error, instead of silently swallowing it.
  if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
    console.warn(`warning: could not load .env: ${err instanceof Error ? err.message : err}`)
  }
}

export interface E2eConfig {
  backendUrl: string
  network: 'mainnet' | 'preprod' | 'preview'
  networkId: number
  mnemonic: string
  amountLovelace: string
  confirmations: number
  pollSeconds: number
}

// preprod and preview are both testnets (network id 0); mainnet is 1.
const NETWORK_ID: Record<E2eConfig['network'], number> = { mainnet: 1, preprod: 0, preview: 0 }
const MAINNET_OPT_IN = 'ALLOW_MAINNET_E2E'

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (trimmed.length === 0) {
    throw new Error(`missing required env var ${name}`)
  }
  return trimmed
}

// Empty or unset falls back to the default; a present-but-invalid value fails loudly
// rather than silently becoming NaN or 0.
function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback
  }
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`invalid ${name} "${value}", expected a positive integer`)
  }
  return n
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): E2eConfig {
  const network = (env.NETWORK ?? 'preprod') as E2eConfig['network']
  if (!(network in NETWORK_ID)) {
    throw new Error(`invalid NETWORK "${network}", expected mainnet | preprod | preview`)
  }
  if (network === 'mainnet' && env[MAINNET_OPT_IN] !== 'true') {
    throw new Error(
      `refusing mainnet E2E run without explicit ${MAINNET_OPT_IN}=true; ` +
        'this harness derives signing keys and can submit transactions that spend real ADA',
    )
  }
  return {
    backendUrl: (env.BACKEND_URL ?? 'http://localhost:3010').replace(/\/+$/, ''),
    network,
    networkId: NETWORK_ID[network],
    mnemonic: required('MNEMONIC', env.MNEMONIC),
    amountLovelace: env.AMOUNT_LOVELACE ?? '1000000',
    confirmations: positiveInt('CONFIRMATIONS', env.CONFIRMATIONS, 1),
    pollSeconds: positiveInt('POLL_SECONDS', env.POLL_SECONDS, 10),
  }
}
