import * as CSL from '@emurgo/cardano-serialization-lib-nodejs'
import type { V1ProtocolParams, V1Utxo } from './v1.js'

const bn = (v: string | number): CSL.BigNum => CSL.BigNum.from_str(String(v))

export interface BuiltTx {
  cborHex: string
  txHash: string
  feeLovelace: string
}

export interface BuildSelfPaymentInput {
  utxos: V1Utxo[]
  params: V1ProtocolParams
  address: string
  amountLovelace: string
  paymentKey: CSL.PrivateKey
}

/**
 * This harness derives one payment key, so it may spend only plain-ADA outputs locked by
 * that key's address. Account UTxO reads include every derived address sharing the stake
 * credential; passing that wider set to coin selection could select an input we cannot sign.
 */
export function spendableUtxosForAddress(utxos: V1Utxo[], address: string): V1Utxo[] {
  return utxos.filter((utxo) => utxo.address === address && utxo.assets.length === 0)
}

/**
 * Build and sign a simple self-payment: spend the keyed address's ADA-only UTxOs, send a
 * fixed amount back to that address, and let CSL compute fee and change. Token UTxOs are
 * ignored for now (a later expansion), which keeps this first slice to plain ADA.
 */
export function buildSelfPayment(input: BuildSelfPaymentInput): BuiltTx {
  const { utxos, params, address, amountLovelace, paymentKey } = input

  const config = CSL.TransactionBuilderConfigBuilder.new()
    .fee_algo(CSL.LinearFee.new(bn(params.minFeeA), bn(params.minFeeB)))
    .pool_deposit(bn(params.poolDeposit))
    .key_deposit(bn(params.keyDeposit))
    .coins_per_utxo_byte(bn(params.coinsPerUtxoByte))
    .max_value_size(params.maxValueSize)
    .max_tx_size(params.maxTxSize)
    .build()

  const builder = CSL.TransactionBuilder.new(config)

  const spendable = spendableUtxosForAddress(utxos, address)
  if (spendable.length === 0) {
    throw new Error('no ADA-only UTxOs available at the signing address')
  }

  const available = CSL.TransactionUnspentOutputs.new()
  for (const u of spendable) {
    const inputRef = CSL.TransactionInput.new(CSL.TransactionHash.from_hex(u.txHash), u.outputIndex)
    const output = CSL.TransactionOutput.new(
      CSL.Address.from_bech32(u.address),
      CSL.Value.new(bn(u.value)),
    )
    available.add(CSL.TransactionUnspentOutput.new(inputRef, output))
  }

  builder.add_inputs_from(available, CSL.CoinSelectionStrategyCIP2.LargestFirst)
  builder.add_output(
    CSL.TransactionOutput.new(CSL.Address.from_bech32(address), CSL.Value.new(bn(amountLovelace))),
  )
  builder.add_change_if_needed(CSL.Address.from_bech32(address))

  const feeLovelace = builder.get_fee_if_set()?.to_str() ?? '0'

  // Sign over the exact body bytes via FixedTransaction so the witness matches what's
  // submitted (no re-serialization hash drift).
  const fixed = CSL.FixedTransaction.new_from_body_bytes(builder.build().to_bytes())
  fixed.sign_and_add_vkey_signature(paymentKey)

  return { cborHex: fixed.to_hex(), txHash: fixed.transaction_hash().to_hex(), feeLovelace }
}
