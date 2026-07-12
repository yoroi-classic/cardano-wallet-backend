### Added

- Chain-wide reads are now cached in process, with request coalescing. `GET /v1/chain/tip` and
  `GET /v1/chain/protocol-params` are identical for every caller, and were being fetched from
  upstream on every single request, so the load we put on the provider grew with our user count
  for no benefit. Measured against live Koios, 20 concurrent clients reading both endpoints now
  cost 2 upstream calls rather than 40, and that number stays flat as clients are added.
- `CACHE_ENABLED` (default `true`) turns it off, for debugging upstream.

### Note

- Account-scoped reads are never cached: account state, UTxOs, transaction history, and
  transaction status all go to upstream on every request. Serving a stale balance or a stale
  UTxO set to a wallet that is about to build a transaction produces a failed submission or a
  double-spend. The full cache policy is one list in `src/providers/cached.ts`, and anything
  absent from it is not cached.
- Protocol parameters are keyed on the epoch number rather than on a duration, so the cached
  value expires exactly when the thing it describes does, instead of at an arbitrary moment that
  may or may not be the epoch boundary.
