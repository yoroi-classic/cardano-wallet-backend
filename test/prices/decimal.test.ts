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

  it('expands a magnitude below the old 18-place window instead of rounding it to zero', () => {
    // toFixed(18) turned anything under ~0.5e-18 into "0"; the expansion keeps every digit.
    expect(toDecimalString(5e-20)).toBe('0.00000000000000000005')
    expect(toDecimalString(1.234e-19)).toBe('0.0000000000000000001234')
    expect(toDecimalString(5e-20)).not.toBe('0')
    expect(toDecimalString(5e-20)).not.toMatch(/e[+-]/i)
  })

  it('expands a large magnitude (>= 1e21) to a plain integer, never scientific notation', () => {
    // toFixed on these just re-emitted the exponent form; shifting the point gives a plain string.
    expect(toDecimalString(1e21)).toBe('1000000000000000000000')
    expect(toDecimalString(1.5e21)).toBe('1500000000000000000000')
    expect(toDecimalString(1e21)).not.toMatch(/e[+-]/i)
    expect(toDecimalString(1.5e21)).not.toMatch(/e[+-]/i)
  })

  it('expands both signs of exponent, and keeps a negative sign through the expansion', () => {
    expect(toDecimalString(-3e-9)).toBe('-0.000000003')
    expect(toDecimalString(-1.5e21)).toBe('-1500000000000000000000')
  })

  it('holds at the boundaries where JavaScript flips to and from exponential notation', () => {
    // 1e-6 prints plain, 1e-7 flips to exponent; both must come back plain-decimal.
    expect(toDecimalString(1e-6)).toBe('0.000001')
    expect(toDecimalString(1e-7)).toBe('0.0000001')
    // 1e20 prints plain, 1e21 flips to exponent; both must come back plain-decimal.
    expect(toDecimalString(1e20)).toBe('100000000000000000000')
    expect(toDecimalString(1e21)).toBe('1000000000000000000000')
  })

  it('rejects a non-finite input rather than stringifying NaN or Infinity', () => {
    expect(() => toDecimalString(NaN)).toThrow(RangeError)
    expect(() => toDecimalString(Infinity)).toThrow(RangeError)
  })
})

describe('divideDecimalStrings', () => {
  const largestPowerOfTen = `1${'0'.repeat(308)}`
  const oversizedPowerOfTen = `1${'0'.repeat(309)}`

  it('divides two decimal strings and formats the result', () => {
    expect(divideDecimalStrings('96650.3017183848', '0.163485')).toBe('591187.5812361061')
  })

  it('rejects an oversized numerator before division', () => {
    expect(() => divideDecimalStrings(oversizedPowerOfTen, '1')).toThrow(RangeError)
  })

  it('rejects an oversized denominator instead of fabricating a zero result', () => {
    expect(() => divideDecimalStrings('100', oversizedPowerOfTen)).toThrow(RangeError)
  })

  it('refuses to divide by zero rather than returning Infinity', () => {
    expect(() => divideDecimalStrings('100', '0')).toThrow(RangeError)
  })

  it('keeps finite boundary operands in plain-decimal notation', () => {
    expect(divideDecimalStrings(largestPowerOfTen, largestPowerOfTen)).toBe('1')
    expect(divideDecimalStrings(largestPowerOfTen, '1')).toBe(largestPowerOfTen)
    expect(divideDecimalStrings('1', largestPowerOfTen)).toBe(`0.${'0'.repeat(307)}1`)
  })
})
