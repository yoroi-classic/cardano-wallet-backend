### Added

- `POST /v1/assets/info` returns metadata for a batch of native tokens by CIP-26 subject.
  Display fields are resolved from the CIP-26 off-chain token registry first, then CIP-25
  on-chain mint metadata (the usual NFT case), then a CIP-68 reference-token datum, and
  `source` says which one supplied them. On-chain basics (fingerprint, supply, names)
  always apply. Sourced from Koios.

### Fixed

- CIP-68 version-4 assets resolve their metadata. Version 4 wraps it in a CIP-25-shaped
  nested map under a `721` key; walking it as if it were version 1 found none of the fields
  and reported the asset as having no metadata at all.
- CIP-68 values split across a list of byte strings (which the spec requires for anything
  over 64 bytes, so most image URIs) are joined rather than dropped.

