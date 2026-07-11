### Added

- `GET /v1/pools` returns a page of registered stake pools ordered by active stake,
  largest first, with an optional case-insensitive `ticker` filter. Neutral by
  construction: no promotional ranking and no house pool. Sourced from Koios.

### Fixed

- A bech32 pool id whose checksum passes but whose 5-bit payload does not convert back to
  bytes is now a 400 rather than a 500.
