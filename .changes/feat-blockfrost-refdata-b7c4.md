### Added

- The Blockfrost provider now answers the reference-data reads that previously returned
  `NotImplementedError`, matching the Koios provider's output shape:
  - `GET /v1/assets/info` (asset metadata), from `/assets/{asset}`. Off-chain CIP-26 registry
    projection is preferred, then Blockfrost's decoded on-chain metadata (CIP-25 traits, or a
    CIP-68 datum resolved server-side), then `source: "none"`.
  - `POST /v1/governance/dreps/info` and `GET /v1/governance/dreps`, from `/governance/dreps`
    and `/governance/dreps/{drep_id}`. Neutral, unranked list, no house DRep. Off-chain CIP-119
    names/images resolved best-effort.
  - `GET /v1/governance/proposals`, from `/governance/proposals`, newest first, with CIP-108
    title/abstract resolved best-effort.
  - `POST /v1/pools/info` and `GET /v1/pools`, from `/pools/{pool_id}` and `/pools/extended`.
    Neutral list ordered by active stake, largest first, honoring the `ticker` filter.

### Note

- Where Blockfrost's API cannot match Koios exactly, the Blockfrost provider degrades rather than
  invents: CIP-68 metadata is limited to what Blockfrost decodes server-side; a DRep's deposit is
  the current protocol parameter (Blockfrost does not echo the per-DRep amount); proposal vote
  tallies are omitted (Blockfrost exposes no vote-summary endpoint); and a pool's `retiring` state
  is not distinguished from `retired`. Each gap is documented at its call site.
