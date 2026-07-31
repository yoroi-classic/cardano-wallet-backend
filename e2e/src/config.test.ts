import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from './config.js'

const TEST_MNEMONIC = 'test-only mnemonic'

test('rejects mainnet before accepting a mnemonic without an exact opt-in', () => {
  const rejectedValues = [undefined, '', 'false', 'TRUE', '1', ' true ', 'true\n']

  for (const allowMainnet of rejectedValues) {
    assert.throws(
      () =>
        loadConfig({
          NETWORK: 'mainnet',
          MNEMONIC: TEST_MNEMONIC,
          ALLOW_MAINNET_E2E: allowMainnet,
        }),
      /refusing mainnet E2E run without explicit ALLOW_MAINNET_E2E=true/,
    )
  }

  assert.throws(
    () => loadConfig({ NETWORK: 'mainnet' }),
    /refusing mainnet E2E run without explicit ALLOW_MAINNET_E2E=true/,
  )
})

test('accepts mainnet only with the exact explicit opt-in', () => {
  const config = loadConfig({
    NETWORK: 'mainnet',
    MNEMONIC: TEST_MNEMONIC,
    ALLOW_MAINNET_E2E: 'true',
  })

  assert.equal(config.network, 'mainnet')
  assert.equal(config.networkId, 1)
})

test('keeps preprod and preview valid without the mainnet opt-in', () => {
  for (const network of ['preprod', 'preview'] as const) {
    const config = loadConfig({ NETWORK: network, MNEMONIC: TEST_MNEMONIC })

    assert.equal(config.network, network)
    assert.equal(config.networkId, 0)
  }
})
