import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs'
import { buildSelfPayment, spendableUtxosForAddress } from './buildTx.js'
import type { V1ProtocolParams, V1Utxo } from './v1.js'

const params: V1ProtocolParams = {
  minFeeA: 44,
  minFeeB: 155_381,
  keyDeposit: '2000000',
  poolDeposit: '500000000',
  coinsPerUtxoByte: '4310',
  maxValueSize: 5000,
  maxTxSize: 16_384,
}

function addressFor(paymentKey: CSL.PrivateKey, stakeKey: CSL.PrivateKey): string {
  const payment = CSL.Credential.from_keyhash(paymentKey.to_public().hash())
  const stake = CSL.Credential.from_keyhash(stakeKey.to_public().hash())
  return CSL.BaseAddress.new(0, payment, stake).to_address().to_bech32()
}

function utxo(
  txHash: string,
  address: string,
  value: string,
  assets: V1Utxo['assets'] = [],
): V1Utxo {
  return { txHash, outputIndex: 0, address, value, assets }
}

describe('E2E self-payment input ownership', () => {
  it('never selects a larger ADA input from another address in the account', () => {
    const paymentKey = CSL.PrivateKey.generate_ed25519()
    const otherPaymentKey = CSL.PrivateKey.generate_ed25519()
    const stakeKey = CSL.PrivateKey.generate_ed25519()
    const signingAddress = addressFor(paymentKey, stakeKey)
    const otherAccountAddress = addressFor(otherPaymentKey, stakeKey)
    const keyedHash = '11'.repeat(32)
    const otherHash = '22'.repeat(32)

    const built = buildSelfPayment({
      // Largest-first would prefer the foreign output if it reached CSL coin selection.
      utxos: [
        utxo(otherHash, otherAccountAddress, '50000000'),
        utxo(keyedHash, signingAddress, '5000000'),
      ],
      params,
      address: signingAddress,
      amountLovelace: '2000000',
      paymentKey,
    })

    const transaction = CSL.FixedTransaction.from_hex(built.cborHex)
    const inputs = transaction.body().inputs()
    assert.equal(inputs.len(), 1)
    assert.equal(inputs.get(0).transaction_id().to_hex(), keyedHash)

    const witnesses = transaction.witness_set().vkeys()
    assert.equal(witnesses?.len(), 1)
    assert.equal(
      witnesses?.get(0).vkey().public_key().hash().to_hex(),
      paymentKey.to_public().hash().to_hex(),
    )
  })

  it('does not treat foreign-address or token outputs as spendable by the held key', () => {
    const paymentKey = CSL.PrivateKey.generate_ed25519()
    const stakeKey = CSL.PrivateKey.generate_ed25519()
    const signingAddress = addressFor(paymentKey, stakeKey)
    const otherAccountAddress = addressFor(CSL.PrivateKey.generate_ed25519(), stakeKey)
    const accountUtxos = [
      utxo('33'.repeat(32), otherAccountAddress, '50000000'),
      utxo('44'.repeat(32), signingAddress, '5000000', [
        { policyId: '55'.repeat(28), assetName: '', quantity: '1' },
      ]),
    ]

    assert.deepEqual(spendableUtxosForAddress(accountUtxos, signingAddress), [])
    assert.throws(
      () =>
        buildSelfPayment({
          utxos: accountUtxos,
          params,
          address: signingAddress,
          amountLovelace: '2000000',
          paymentKey,
        }),
      /no ADA-only UTxOs available at the signing address/,
    )
  })
})
