### Fixed

- Token charts and 7d/30d activity are now cached against the selected ADA pool as well as the
  asset and range. A liquidity-driven pool change fetches that market's candles immediately
  instead of serving the superseded pool for the remainder of the history TTL.
