import * as CML from '@dcspark/cardano-multiplatform-lib-nodejs'
import type { V1ProtocolParams, V1Utxo } from './v1.js'

const parseUnsigned = (value: string | number, field: string): bigint => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer`)
  }

  const encoded = String(value)
  if (!/^(0|[1-9][0-9]*)$/.test(encoded)) {
    throw new Error(`${field} must be a non-negative integer`)
  }

  return BigInt(encoded)
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
 * This harness derives one payment key, so it may spend only plain-ADA outputs locked by
 * that key's address. Account UTxO reads include every derived address sharing the stake
 * credential; passing that wider set to coin selection could select an input we cannot sign.
 */
export function spendableUtxosForAddress(utxos: V1Utxo[], address: string): V1Utxo[] {
  return utxos.filter((utxo) => utxo.address === address && utxo.assets.length === 0)
}

/**
 * Build and sign a simple self-payment: spend the keyed address's ADA-only UTxOs, send a
 * fixed amount back to that address, and let CML compute fee and change. Token UTxOs are
 * ignored for now (a later expansion), which keeps this first slice to plain ADA.
 */
export function buildSelfPayment(input: BuildSelfPaymentInput): BuiltTx {
  const { utxos, params, address, amountLovelace, paymentKey } = input
  const spendable = spendableUtxosForAddress(utxos, address)
  if (spendable.length === 0) {
    throw new Error('no ADA-only UTxOs available at the signing address')
  }

  const config = CML.TransactionBuilderConfigBuilder.new()
    .fee_algo(
      CML.LinearFee.new(
        parseUnsigned(params.minFeeA, 'minFeeA'),
        parseUnsigned(params.minFeeB, 'minFeeB'),
        0n,
      ),
    )
    .ex_unit_prices(
      CML.ExUnitPrices.new(
        CML.Rational.new(0n, 1n),
        CML.Rational.new(0n, 1n),
      ),
    )
    .collateral_percentage(params.collateralPercent)
    .max_collateral_inputs(params.maxCollateralInputs)
    .cost_models(CML.CostModels.from_json('{}'))
    .pool_deposit(parseUnsigned(params.poolDeposit, 'poolDeposit'))
    .key_deposit(parseUnsigned(params.keyDeposit, 'keyDeposit'))
    .coins_per_utxo_byte(parseUnsigned(params.coinsPerUtxoByte, 'coinsPerUtxoByte'))
    .max_value_size(params.maxValueSize)
    .max_tx_size(params.maxTxSize)
    .build()

  const builder = CML.TransactionBuilder.new(config)
  const changeAddress = CML.Address.from_bech32(address)

  for (const u of spendable) {
    const inputRef = CML.TransactionInput.new(
      CML.TransactionHash.from_hex(u.txHash),
      parseUnsigned(u.outputIndex, 'outputIndex'),
    )
    const output = CML.TransactionOutput.new(
      CML.Address.from_bech32(u.address),
      CML.Value.from_coin(parseUnsigned(u.value, 'UTxO value')),
    )
    const input = CML.SingleInputBuilder.new(inputRef, output).payment_key()
    builder.add_utxo(input)
  }

  builder.add_output(
    CML.TransactionOutputBuilder.new()
      .with_address(changeAddress)
      .next()
      .with_value(CML.Value.from_coin(parseUnsigned(amountLovelace, 'amountLovelace')))
      .build(),
  )
  builder.select_utxos(CML.CoinSelectionStrategyCIP2.LargestFirst)

  const signedBuilder = builder.build(CML.ChangeSelectionAlgo.Default, changeAddress)
  const body = signedBuilder.body()
  const bodyHash = CML.hash_transaction(body)
  const feeLovelace = body.fee().toString()

  signedBuilder.add_vkey(CML.make_vkey_witness(bodyHash, paymentKey))
  const transaction = signedBuilder.build_checked()

  return { cborHex: transaction.to_cbor_hex(), txHash: bodyHash.to_hex(), feeLovelace }
}
