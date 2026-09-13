import { bech32 } from '@scure/base'

// Shelley reward addresses are one header byte plus a 28-byte staking credential.
const REWARD_ADDRESS_BYTES = 29
const REWARD_KEY_HASH_TYPE = 0x0e
const REWARD_SCRIPT_HASH_TYPE = 0x0f
const MAINNET_NETWORK_ID = 1
const BECH32_LIMIT = 1023

function configuredNetworkId(network: string): number | undefined {
  if (network === 'mainnet') return MAINNET_NETWORK_ID
  if (network === 'preprod' || network === 'preview') return 0
  return undefined
}

/**
 * Whether a value is a Shelley reward address for the network this service is configured to
 * serve. These addresses are commonly called stake addresses at the API boundary.
 *
 * A valid Bech32 checksum and `stake` HRP are not enough: the decoded header has to name a reward
 * key/script credential, carry the same network as the HRP, and match the configured deployment.
 * Cardano assigns network id 0 to both preprod and preview, so reward-address bytes cannot
 * distinguish those deployments; the deployment's `/v1/status` response identifies the configured
 * network.
 * Conversion is deliberately non-throwing so malformed 5-bit padding remains caller input rather
 * than becoming an internal error.
 */
export function isStakeAddressForNetwork(value: string, network: string): boolean {
  const decoded = bech32.decodeUnsafe(value, BECH32_LIMIT)
  if (decoded === undefined) return false

  const bytes = bech32.fromWordsUnsafe(decoded.words)
  if (bytes === undefined || bytes.length !== REWARD_ADDRESS_BYTES) return false

  const header = bytes[0]
  if (header === undefined) return false
  const addressType = header >> 4
  if (addressType !== REWARD_KEY_HASH_TYPE && addressType !== REWARD_SCRIPT_HASH_TYPE) return false

  const networkId = header & 0x0f
  const expectedPrefix = networkId === MAINNET_NETWORK_ID ? 'stake' : 'stake_test'
  if (decoded.prefix !== expectedPrefix) return false

  const expectedNetworkId = configuredNetworkId(network)
  return expectedNetworkId !== undefined && networkId === expectedNetworkId
}
