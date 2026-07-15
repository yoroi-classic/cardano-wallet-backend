### Added

- `POST /v1/assets/info` now returns NFT `traits`: the collection-specific attributes a minter
  attached, e.g. `{"background": "Seafoam Green", "accessories": "Spider"}`. Replaces the
  dullahan `GET /tokens/nft/traits/{tokenId}`.
- They cost **no extra upstream call**: the traits were already inside the CIP-25 metadata this
  endpoint fetches, so there is no new endpoint and no new round trip. A client that already reads
  token metadata gets them for free.
- Traits are what the spec did **not** reserve. CIP-25 defines `name`, `image`, `description`,
  `mediaType` and `files` and says nothing about the rest of the map, so a minter's traits are
  simply whatever is left over. We subtract rather than allowlist, because any allowlist would
  silently drop the traits of the next collection to mint.
- No rarity. "2% of the collection has Spider" cannot be computed from one asset: it needs every
  asset in the policy, which for a large collection is over a hundred upstream calls. That is an
  indexing job, not a request, and it is tracked separately.
