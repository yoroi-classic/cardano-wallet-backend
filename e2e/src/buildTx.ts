import * as CML from '@dcspark/cardano-multiplatform-lib-nodejs'
import type { V1ProtocolParams, V1Utxo } from './v1.js'

function rationalFromDecimal(value: number): CML.Rational {
  const [coefficient = '0', exponentText] = value.toString().toLowerCase().split('e')
  const exponent = Number(exponentText ?? '0')
  const [whole = '0', fraction = ''] = coefficient.split('.')
  let numerator = BigInt(`${whole}${fraction}`)
  let scale = fraction.length - exponent
  if (scale < 0) {
    numerator *= 10n ** BigInt(-scale)
    scale = 0
  }
  let denominator = 10n ** BigInt(scale)
  let a = numerator
  let b = denominator
  while (b !== 0n) [a, b] = [b, a % b]
  return CML.Rational.new(numerator / a, denominator / a)
}

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
  paymentKey: CML.PrivateKey
}

/**
 * Build and sign a simple self-payment: spend the account's ADA-only UTxOs, send a fixed
 * amount back to the same address, and let CML compute fee and change. Token UTxOs are
 * ignored for now (a later expansion), which keeps this first slice to plain ADA.
 */
export function buildSelfPayment(input: BuildSelfPaymentInput): BuiltTx {
  const { utxos, params, address, amountLovelace, paymentKey } = input

  const config = CML.TransactionBuilderConfigBuilder.new()
    .fee_algo(CML.LinearFee.new(BigInt(params.minFeeA), BigInt(params.minFeeB), 0n))
    .pool_deposit(BigInt(params.poolDeposit))
    .key_deposit(BigInt(params.keyDeposit))
    .coins_per_utxo_byte(BigInt(params.coinsPerUtxoByte))
    .max_value_size(params.maxValueSize)
    .max_tx_size(params.maxTxSize)
    .ex_unit_prices(
      CML.ExUnitPrices.new(rationalFromDecimal(params.priceMem), rationalFromDecimal(params.priceStep)),
    )
    .cost_models(CML.CostModels.from_json(JSON.stringify(params.costModels)))
    .collateral_percentage(params.collateralPercent)
    .max_collateral_inputs(params.maxCollateralInputs)
    .build()

  const builder = CML.TransactionBuilder.new(config)

  const adaOnly = utxos.filter((u) => u.assets.length === 0)
  if (adaOnly.length === 0) {
    throw new Error('no ADA-only UTxOs available to spend')
  }

  for (const u of adaOnly) {
    const inputRef = CML.TransactionInput.new(CML.TransactionHash.from_hex(u.txHash), BigInt(u.outputIndex))
    const output = CML.TransactionOutputBuilder.new()
      .with_address(CML.Address.from_bech32(u.address))
      .next()
      .with_value(CML.Value.from_coin(BigInt(u.value)))
      .build()
      .output()
    builder.add_utxo(CML.SingleInputBuilder.new(inputRef, output).payment_key())
  }

  const output = CML.TransactionOutputBuilder.new()
    .with_address(CML.Address.from_bech32(address))
    .next()
    .with_value(CML.Value.from_coin(BigInt(amountLovelace)))
    .build()
  builder.add_output(output)
  builder.select_utxos(CML.CoinSelectionStrategyCIP2.LargestFirst)
  builder.add_change_if_needed(CML.Address.from_bech32(address), false)

  const signed = builder.build(CML.ChangeSelectionAlgo.Default, CML.Address.from_bech32(address))
  const bodyHash = CML.hash_transaction(signed.body())
  signed.add_vkey(CML.make_vkey_witness(bodyHash, paymentKey))
  const tx = signed.build_unchecked()

  return {
    cborHex: tx.to_cbor_hex(),
    txHash: CML.hash_transaction(tx.body()).to_hex(),
    feeLovelace: tx.body().fee().toString(),
  }
}
