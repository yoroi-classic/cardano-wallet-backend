import assert from 'node:assert/strict'
import test from 'node:test'
import * as CML from '@dcspark/cardano-multiplatform-lib-nodejs'
import { formatAda } from './amount.js'
import { buildSelfPayment } from './buildTx.js'
import { deriveWallet } from './wallet.js'

const testMnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

test('formats lovelace without unsafe number conversion', () => {
  assert.equal(formatAda('9007199254740993123'), '9007199254740.993123')
  assert.equal(formatAda('0'), '0.000000')
  assert.equal(formatAda('-1'), '-0.000001')
})

test('CML derives CIP-1852 wallet addresses and builds a signed self-payment', () => {
  const wallet = deriveWallet(testMnemonic, 0)
  assert.match(wallet.paymentAddress, /^addr_test1/)
  assert.match(wallet.stakeAddress, /^stake_test1/)
  assert.match(wallet.unusedAddress, /^addr_test1/)

  const tx = buildSelfPayment({
    utxos: [
      {
        txHash: '11'.repeat(32),
        outputIndex: 0,
        address: wallet.paymentAddress,
        value: '10000000',
        assets: [],
      },
    ],
    params: {
      minFeeA: 44,
      minFeeB: 155381,
      keyDeposit: '2000000',
      poolDeposit: '500000000',
      coinsPerUtxoByte: '4310',
      maxValueSize: 5000,
      maxTxSize: 16384,
      collateralPercent: 150,
      maxCollateralInputs: 3,
      priceMem: 0.0577,
      priceStep: 0.0000721,
      costModels: {},
    },
    address: wallet.paymentAddress,
    amountLovelace: '3000000',
    paymentKey: wallet.paymentKey,
  })

  const parsed = CML.Transaction.from_cbor_hex(tx.cborHex)
  assert.equal(CML.hash_transaction(parsed.body()).to_hex(), tx.txHash)
  assert.equal(parsed.body().fee().toString(), tx.feeLovelace)
  const bodyHash = CML.hash_transaction(parsed.body())
  const witnesses = parsed.witness_set().vkeywitnesses()
  assert.ok(witnesses)
  assert.equal(witnesses.len(), 1)
  const witness = witnesses.get(0)
  assert.equal(witness.vkey().verify(bodyHash.to_raw_bytes(), witness.ed25519_signature()), true)
  const minimumFee = CML.min_no_script_fee(parsed, CML.LinearFee.new(44n, 155381n, 0n))
  assert.ok(BigInt(tx.feeLovelace) >= minimumFee)
  assert.equal(parsed.body().inputs().len(), 1)
})
