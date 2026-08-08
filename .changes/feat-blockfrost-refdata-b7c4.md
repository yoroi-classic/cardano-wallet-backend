### Added

- The Blockfrost provider now answers the reference-data reads that previously returned
  `NotImplementedError`, matching the Koios provider's output shape:
  - `GET /v1/assets/info` (asset metadata), from `/assets/{asset}`. Off-chain CIP-26 registry
    projection is preferred, then Blockfrost's decoded on-chain metadata (CIP-25 traits, or a
    CIP-68 datum resolved server-side), then `source: "none"`. Chunked CIP-25 name, description,
    image, and url values are re-joined.
  - `POST /v1/governance/dreps/info` and `GET /v1/governance/dreps`, from `/governance/dreps`
    and `/governance/dreps/{drep_id}`. Neutral, unranked list, no house DRep. Off-chain CIP-119
    names/images resolved best-effort.
  - `GET /v1/governance/proposals`, from `/governance/proposals`, newest first, with CIP-108
    title/abstract resolved best-effort.
  - `POST /v1/pools/info` and `GET /v1/pools`, from `/pools/{pool_id}` and `/pools/extended`,
    with `/pools/retiring` consulted so a scheduled retirement is reported as `retiring` (with
    its `retiringEpoch`) rather than `retired`. Neutral list ordered by active stake, largest
    first, honoring the `ticker` filter and cached per epoch like the Koios pool ranking.

### Changed

- `Proposal.proposedEpoch` is now optional. Koios still reports it; Blockfrost exposes no proposed
  epoch and only the current `gov_action_lifetime`, which cannot correctly date a historical
  proposal, so it is left absent rather than derived from a possibly-changed parameter.

### Note

- Two gaps remain where Blockfrost's API cannot match Koios: CIP-68 metadata is limited to what
  Blockfrost decodes server-side, and proposal vote tallies are omitted (Blockfrost exposes no
  vote-summary endpoint, only power-less individual votes). A DRep's `deposit` is reported as the
  current protocol parameter, since Blockfrost does not echo the per-DRep amount. Each is
  documented at its call site.
