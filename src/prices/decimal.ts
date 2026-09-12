/**
 * Turning a upstream-derived float into the decimal *string* our domain types require.
 *
 * `TokenActivity.priceAda` and `volumeAda` are strings for exactly one reason: a long-tail token
 * can price at 1e-9 ADA, and a plain JSON number would round that away or print it as `1e-9`,
 * which is technically a number but not a decimal a naive parser expects. See STYLE_GUIDE.md.
 *
 * Wherever GeckoTerminal itself hands us the value as a decimal string already (the pool
 * attributes it returns for the 24h case), it is passed straight through untouched: that is the
 * only way to guarantee no precision is lost, and it costs nothing. This module exists for the
 * cases where we have to derive the number ourselves (an OHLCV close, a USD-to-ADA volume
 * conversion): upstream already gave us a JSON *number* there, so the float is unavoidable, but
 * we still owe the caller a plain decimal string rather than JavaScript's own notation.
 */

/**
 * Format a finite number as a plain decimal string: never scientific notation, and never with
 * more digits than the float actually carries.
 *
 * `String(n)` is used first because it is JavaScript's own shortest round-tripping
 * representation, which is exactly right for ordinary-magnitude prices and avoids introducing
 * binary-floating-point noise that a fixed-digit format would expose (`(123456.789).toFixed(18)`
 * prints trailing garbage that isn't really there). It only needs expanding for the magnitudes
 * where JavaScript itself switches to exponential notation (roughly `|n| < 1e-6`, or `|n| >= 1e21`).
 *
 * That expansion works off the exponent in `String(n)` rather than a fixed number of decimal
 * places. A fixed `toFixed(18)` broke the plain-decimal contract at both ends of the window: a
 * magnitude below ~0.5e-18 rounded to `0`, and a value `>= 1e21` came back still in scientific
 * notation, because `toFixed` on those just re-emits the exponent form. Shifting the decimal point
 * by the actual exponent keeps every digit the float carries and stays plain-decimal at any
 * magnitude.
 */
export function toDecimalString(n: number): string {
  if (!Number.isFinite(n)) {
    throw new RangeError(`cannot format a non-finite number as a decimal string: ${n}`)
  }

  const str = n.toString()
  if (!/e/i.test(str)) return str
  return expandExponential(str)
}

/**
 * Rewrite a JavaScript exponential literal (`1.234e-9`, `1e+21`) as a plain decimal string by
 * shifting the decimal point by the exponent, preserving exactly the digits present.
 */
function expandExponential(str: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(str)
  // `str` always carries an exponent when this is called, but guard rather than assert.
  if (match === null) return str

  const sign = match[1] ?? ''
  const intPart = match[2] ?? '0'
  const fracPart = match[3] ?? ''
  const exponent = Number(match[4])

  const digits = intPart + fracPart
  // Where the decimal point lands, counting from the left of `digits`, after applying the exponent.
  const pointPos = intPart.length + exponent

  let body: string
  if (pointPos <= 0) {
    // Point is left of every digit: a leading `0.` and enough zeros to reach the first digit.
    body = `0.${'0'.repeat(-pointPos)}${digits}`
  } else if (pointPos >= digits.length) {
    // Point is right of every digit: an integer, padded with trailing zeros. No fractional part,
    // so its trailing zeros are significant and must not be stripped below.
    return `${sign}${digits}${'0'.repeat(pointPos - digits.length)}`
  } else {
    body = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`
  }

  // Only a fractional result reaches here; drop any trailing zeros the split left behind.
  return `${sign}${body.replace(/0+$/, '').replace(/\.$/, '')}`
}

/**
 * Divide two upstream decimal strings and return a plain decimal string.
 *
 * Used for exactly one thing: converting a USD-denominated volume to ADA using the ADA/USD price
 * from the very same pool snapshot (`volumeUsd / adaUsdPrice`). This is a unit conversion of real
 * market data, not an invented figure, but it does go through a float division, so it is held to
 * the same formatting as `toDecimalString` rather than to `String()`'s default.
 */
export function divideDecimalStrings(numerator: string, denominator: string): string {
  const numeratorValue = Number(numerator)
  const denominatorValue = Number(denominator)
  if (!Number.isFinite(numeratorValue)) {
    throw new RangeError('cannot divide with a non-finite numerator')
  }
  if (!Number.isFinite(denominatorValue)) {
    throw new RangeError('cannot divide with a non-finite denominator')
  }
  if (denominatorValue === 0) {
    throw new RangeError('cannot divide by a zero denominator')
  }
  return toDecimalString(numeratorValue / denominatorValue)
}
