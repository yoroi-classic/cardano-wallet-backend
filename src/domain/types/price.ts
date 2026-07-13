/**
 * Price and market data.
 *
 * The shapes are defined and the routes are reserved, but nothing serves them yet: every endpoint
 * answers `501 NOT_IMPLEMENTED`. See src/http/routes/price.ts for why that is deliberate rather
 * than lazy.
 *
 * Price is the one domain in this service with no on-chain source. Neither Koios nor Blockfrost
 * nor a node we run ourselves knows what ADA is worth in dollars, because that fact does not
 * exist on the chain. It has to come from a market data provider, and choosing one is a decision
 * about cost, licensing and trust that has not been made.
 */

/** A fiat or crypto currency code, e.g. `USD`, `JPY`, `BTC`. */
export type CurrencyCode = string

/** What ADA is currently worth, in each requested currency. */
export interface AdaPrice {
  /** Price per ADA, keyed by currency code. A float: this is a price, not a ledger amount. */
  prices: Record<CurrencyCode, number>
  /** Percentage change over the last 24 hours, keyed by currency code. */
  changePercent24h: Record<CurrencyCode, number>
  /** When the quote was taken, as unix seconds. A stale price must be visibly stale. */
  asOf: number
}

/** One candle. */
export interface Ohlc {
  /** Start of the candle, unix seconds. */
  time: number
  open: number
  high: number
  low: number
  close: number
}

/** The windows a client may ask for activity over. */
export const PRICE_WINDOWS = ['24h', '7d', '30d'] as const
export type PriceWindow = (typeof PRICE_WINDOWS)[number]

/** Recent market activity for one native token, priced in ADA. */
export interface TokenActivity {
  /** `policyId + assetNameHex`, the same subject key /v1/assets/info uses. */
  subject: string
  /**
   * Price in ADA, as a decimal string.
   *
   * A string, unlike the fiat prices above, because a token price in ADA can be both very small
   * and very precise (a long-tail token trades at 1e-9 ADA), and a float would quietly round it.
   */
  priceAda: string
  /** Percentage change across the requested window. */
  changePercent: number
  /** Volume over the window, in ADA, as a decimal string. */
  volumeAda: string
}
