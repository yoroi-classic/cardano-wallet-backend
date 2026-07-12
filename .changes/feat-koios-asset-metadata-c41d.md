### Added

- `POST /v1/assets/info` returns metadata for a batch of native tokens by CIP-26 subject.
  Display fields are resolved from the CIP-26 off-chain token registry first, then CIP-25
  on-chain mint metadata (the usual NFT case), then a CIP-68 reference-token datum, and
  `source` says which one supplied them. On-chain basics (fingerprint, supply, names)
  always apply. Sourced from Koios.
