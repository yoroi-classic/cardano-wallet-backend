### Added

- The price surface (#6) now answers for real, instead of the `501` stub reserved for it:
  - `GET /v1/price/ada` — ADA's fiat price and 24h change, per currency, from CoinGecko.
  - `GET /v1/price/ada/history` — ADA OHLC candles, from CoinGecko.
  - `POST /v1/price/tokens` — native-token price, 24h/7d/30d change, and volume, **in ADA**, from
    GeckoTerminal (a CoinGecko product). This is mobile's only source of a primary-token price.
  - `POST /v1/price/tokens/history` — a token's OHLC price chart, in ADA, from GeckoTerminal.

  Both upstreams are public and keyless at the tier used here. `COINGECKO_API_KEY` is an optional
  new config field for a higher CoinGecko rate limit; unset works fine.

- Every native-token price is read from the pool that pairs the token **directly with ADA**, never
  guessed at through a stablecoin pool and a separate fiat conversion. A token with no such pool
  (no real liquidity, or one GeckoTerminal has never indexed) is reported as unavailable: omitted
  from the `/v1/price/tokens` batch, or an empty candle list from the history endpoint. Never a
  price of zero.

- An upstream failure (a timeout, a 5xx, a malformed body) still surfaces as the usual `502`/`504`,
  never a fake number. The one rule this whole surface existed to enforce even as a stub, carried
  over unchanged now that it has a real provider behind it.

- Cached (#47): a live ADA price or token quote for a minute, OHLC history for five. Every wallet
  asking the same question gets the same cached answer, so call volume against CoinGecko and
  GeckoTerminal does not scale with users.
