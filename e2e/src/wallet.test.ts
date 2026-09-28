import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deriveWallet } from './wallet.js'

describe('CML CIP-1852 wallet derivation', () => {
  it('derives the expected test addresses from a test-only BIP-39 vector', () => {
    const wallet = deriveWallet(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      0,
    )

    assert.equal(
      wallet.paymentAddress,
      'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn',
    )
    assert.equal(
      wallet.stakeAddress,
      'stake_test1urj40zgr2gy4788kl54h6x3gu0pukq5lfr8nflufpg5dzas324ywz',
    )
    assert.equal(
      wallet.unusedAddress,
      'addr_test1qp924t8sa4ygwjgc2dqpw4jwdr6383y7h6rx8pxl4nxatg0927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqy7cyrh',
    )
  })
})
