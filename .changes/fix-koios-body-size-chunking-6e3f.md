### Changed

- Batch requests to Koios are packed against the documented 5,120-byte body limit instead of a
  fixed item count. The counts we used (50 pool ids, 50 DRep ids, 20 asset subjects) were each
  arrived at by bisecting against a 413, and they left most of the budget unused: 84 pool ids fit
  where we were sending 50, so hydrating a page of the pool list now takes 3 upstream requests
  rather than 5, verified against live mainnet. Chunks of one batch are also sent concurrently
  rather than one after another.

### Fixed

- An `asset_info` batch can no longer exceed the upstream body limit. A subject is a policy id
  plus an asset name of 0 to 64 hex chars, so it is variable length, and chunking it by a fixed
  count of 20 was safe only because 20 worst-case subjects happened to fit. Nothing enforced
  that. Packing measures the real serialized body, so it is safe by construction.
- If upstream rejects a body with a 413 that names a smaller limit than we packed to (a proxy, or
  a self-hosted Koios with a tighter cap), that limit is adopted, the items are repacked, and the
  batch is retried once. Previously it took a redeploy.
