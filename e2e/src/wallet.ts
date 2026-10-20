import * as CML from '@dcspark/cardano-multiplatform-lib-nodejs'
import { mnemonicToEntropy } from 'bip39'

// Use dcSpark CML as the Yoroi clients' migration target; they currently use CSL.

const HARDENED = 0x80000000

export interface Wallet {
  /** Raw payment signing key. */
  paymentKey: CML.PrivateKey
  /** Bech32 base (payment) address, the account's spend/receive address. */
  paymentAddress: string
  /** Bech32 stake address, the key our /v1 account endpoints are looked up by. */
  stakeAddress: string
  /**
   * A far-out derived payment address (external chain, high index) that we never fund.
   * Valid bech32 for the same account, so filter-used should accept it as well-formed yet
   * report it as unused, letting the harness check both sides of the filter.
   */
  unusedAddress: string
}

/** Derive the first account's payment and stake credentials from a mnemonic. */
export function deriveWallet(mnemonic: string, networkId: number): Wallet {
  const entropy = mnemonicToEntropy(mnemonic)
  const root = CML.Bip32PrivateKey.from_bip39_entropy(Buffer.from(entropy, 'hex'), Buffer.from(''))
  const account = root
    .derive(HARDENED + 1852)
    .derive(HARDENED + 1815)
    .derive(HARDENED + 0)
  const paymentBip = account.derive(0).derive(0)
  const stakeBip = account.derive(2).derive(0)
  const unusedBip = account.derive(0).derive(1000)

  const paymentCred = CML.Credential.new_pub_key(paymentBip.to_public().to_raw_key().hash())
  const stakeCred = CML.Credential.new_pub_key(stakeBip.to_public().to_raw_key().hash())
  const unusedCred = CML.Credential.new_pub_key(unusedBip.to_public().to_raw_key().hash())
  const paymentAddress = CML.BaseAddress.new(networkId, paymentCred, stakeCred).to_address()
  const stakeAddress = CML.RewardAddress.new(networkId, stakeCred).to_address()
  const unusedAddress = CML.BaseAddress.new(networkId, unusedCred, stakeCred).to_address()

  return {
    paymentKey: paymentBip.to_raw_key(),
    paymentAddress: paymentAddress.to_bech32(),
    stakeAddress: stakeAddress.to_bech32(),
    unusedAddress: unusedAddress.to_bech32(),
  }
}
