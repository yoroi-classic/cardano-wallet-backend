### Added

- `GET /v1/governance/dreps` returns a neutral, unranked page of registered DReps, ordered
  by id. No promotional ranking and no house DRep.
- `POST /v1/governance/dreps/info` returns info for a batch of DReps by bech32 id. Both the
  current CIP-129 form and the deprecated CIP-105 form are accepted on the way in; CIP-129
  is always what gets emitted. Off-chain CIP-119 names and images are resolved best-effort.

### Fixed

- `limit` and `offset` on the DRep list are validated rather than coerced. `?offset=`,
  `?offset=1e3` and `?offset=0x10` were silently read as 0, 1000 and 16 respectively; they
  are now 400s.
