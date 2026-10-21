import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatAda } from './amount.js'

describe('formatAda', () => {
  it('formats large lovelace values without unsafe Number conversion', () => {
    assert.equal(formatAda('9007199254740993123'), '9007199254740.993123')
  })

  it('formats zero, fractions, and negative values with six decimal places', () => {
    assert.equal(formatAda('0'), '0.000000')
    assert.equal(formatAda('1'), '0.000001')
    assert.equal(formatAda('-1'), '-0.000001')
    assert.equal(formatAda('-1000001'), '-1.000001')
  })
})
