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
 * prints trailing garbage that isn't really there). It only falls back to `toFixed` for the
 * magnitudes where JavaScript itself switches to exponential notation (roughly `|n| < 1e-6` or
 * very large), where that noise is not a practical concern.
 */
export function toDecimalString(n: number): string {
  if (!Number.isFinite(n)) {
    throw new RangeError(`cannot format a non-finite number as a decimal string: ${n}`)
  }

  const str = n.toString()
  if (!/e/i.test(str)) return str

  // 18 places comfortably covers any realistic Cardano native-token price ratio (a long-tail
  // token at 1e-9 ADA, say) without pretending to recover precision beyond what the float
  // already lost. A value smaller than ~1e-18 would round to zero here; that is a documented
  // limit of representing this as a JS number at all; the 24h path above (GeckoTerminal's own
  // decimal string) never falls into it because it never converts through a float first.
  const fixed = n.toFixed(18)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
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
  const denominatorValue = Number(denominator)
  if (denominatorValue === 0) {
    throw new RangeError('cannot divide by a zero denominator')
  }
  return toDecimalString(Number(numerator) / denominatorValue)
}
