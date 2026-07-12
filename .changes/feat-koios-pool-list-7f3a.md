### Added

- `GET /v1/pools` returns a page of registered stake pools ordered by active stake,
  largest first, with an optional case-insensitive `ticker` filter. Neutral by
  construction: no promotional ranking and no house pool. Sourced from Koios.

### Fixed

- A bech32 pool id whose checksum passes but whose 5-bit payload does not convert back to
  bytes is now a 400 rather than a 500.
- `limit` and `offset` on the pool list are validated rather than coerced. `?offset=`,
  `?offset=1e3` and `?offset=0x10` were silently read as 0, 1000 and 16 respectively; they
  are now 400s.
- The pool list asks Koios for a deterministic row order while paging. A limit/offset walk
  with no ordering has no defined row order upstream, so pages could overlap or leave gaps
  and a pool could be served twice, or never at all.
