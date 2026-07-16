import { describe, expect, it } from 'vitest'
import { divideDecimalStrings, toDecimalString } from '../../src/prices/decimal.js'

describe('toDecimalString', () => {
  it('formats an ordinary-magnitude number as-is', () => {
    expect(toDecimalString(0.0300716778022995)).toBe('0.0300716778022995')
    expect(toDecimalString(123456.789)).toBe('123456.789')
    expect(toDecimalString(0)).toBe('0')
  })

  it('never emits scientific notation for a very small magnitude', () => {
    expect(toDecimalString(1e-9)).toBe('0.000000001')
    expect(toDecimalString(1e-9)).not.toMatch(/e[+-]/i)
  })

  it('preserves a negative sign', () => {
    expect(toDecimalString(-1.5)).toBe('-1.5')
  })

  it('rejects a non-finite input rather than stringifying NaN or Infinity', () => {
    expect(() => toDecimalString(NaN)).toThrow(RangeError)
    expect(() => toDecimalString(Infinity)).toThrow(RangeError)
  })
})

describe('divideDecimalStrings', () => {
  it('divides two decimal strings and formats the result', () => {
    expect(divideDecimalStrings('96650.3017183848', '0.163485')).toBe('591187.5812361061')
  })

  it('refuses to divide by zero rather than returning Infinity', () => {
    expect(() => divideDecimalStrings('100', '0')).toThrow(RangeError)
  })
})
