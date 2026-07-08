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

function required(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(`missing required env var ${name}`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): E2eConfig {
  const network = (env.NETWORK ?? 'preprod') as E2eConfig['network']
  if (!(network in NETWORK_ID)) {
    throw new Error(`invalid NETWORK "${network}", expected mainnet | preprod | preview`)
  }
  return {
    backendUrl: (env.BACKEND_URL ?? 'http://localhost:3010').replace(/\/+$/, ''),
    network,
    networkId: NETWORK_ID[network],
    mnemonic: required('MNEMONIC', env.MNEMONIC).trim(),
    amountLovelace: env.AMOUNT_LOVELACE ?? '1000000',
    confirmations: Number(env.CONFIRMATIONS ?? '1'),
    pollSeconds: Number(env.POLL_SECONDS ?? '10'),
  }
}
