### Added

- `GET /v1/pools` returns a page of registered stake pools ordered by active stake, largest
  first, with ties broken by pool id so paging is stable, and an optional case-insensitive
  `ticker` filter. Neutral by construction: no promotional ranking and no house pool.
  `limit` and `offset` are validated as plain integers rather than coerced, so `?offset=1e3`
  or `?offset=0x10` is a 400 rather than being quietly read as 1000 or 16. Sourced from
  Koios.

### Fixed

- A bech32 pool id whose checksum passes but whose 5-bit payload does not convert back to
  bytes is now a 400 from `POST /v1/pools/info` rather than a 500.
