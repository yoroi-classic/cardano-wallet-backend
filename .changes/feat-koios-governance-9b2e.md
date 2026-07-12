### Added

- `GET /v1/governance/dreps` returns a neutral, unranked page of registered DReps, ordered
  by id. No promotional ranking and no house DRep.
- `POST /v1/governance/dreps/info` returns info for a batch of DReps by bech32 id. Both the
  current CIP-129 form and the deprecated CIP-105 form are accepted on the way in; CIP-129
  is always what gets emitted. Off-chain CIP-119 names and images are resolved best-effort.
  A DRep the chain has never heard of comes back with `status: "not_registered"` rather than
  being dropped, so a caller can tell that apart from a failed lookup.
