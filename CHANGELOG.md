# Changelog

All notable changes to this project are recorded here. The format follows
Keep a Changelog, and the project uses semantic versioning.

## [0.10.0] - 2026-07-08

Resolves NFT and non-registry token metadata from on-chain CIP-25.

### Added

- `POST /v1/assets/info` now falls back to CIP-25 on-chain mint metadata when a token has
  no CIP-26 registry entry (the usual NFT case): `name`, `description`, and an `image`
  pointer. A new `source` field (`registry` | `cip25` | `none`) says where the display
  fields came from; the registry is preferred over CIP-25. CIP-25 chunked strings are
  joined, and the asset key is matched by either its hex or decoded name. All of this comes
  from the `asset_info` response already fetched, so no extra upstream calls.
- Live preprod integration coverage that resolves CIP-25 metadata for a real NFT.

### Note

- `image` is a pointer (e.g. `ipfs://...`), not image bytes. CIP-68 datum metadata is the
  next asset addition; it needs PlutusData decoding and is deliberately separate.

## [0.9.0] - 2026-07-08

Adds native-token metadata for the assets a wallet holds.

### Added

- `POST /v1/assets/info`: given `{ subjects: [...] }` (a subject is a policy id plus the
  hex asset name), returns normalized token metadata in input order: on-chain basics
  (fingerprint, total supply, decoded asset name) plus the CIP-26 off-chain token registry
  fields (name, ticker, description, decimals, url). Built from Koios `asset_info`. Batches
  are chunked to stay under the upstream request-body cap; malformed subjects are rejected
  with `400` and unknown subjects are omitted.
- Live preprod integration coverage for token metadata against a real on-chain asset.

### Note

- Two things the closed backend served are intentionally out of scope here because they
  are not raw chain data: editorial curation (scam/verified status, an "application"
  category, a display symbol), which needs a separate curated dataset; and token/NFT
  images, which are served from a media surface rather than inlined as base64. CIP-25 and
  CIP-68 on-chain metadata fallbacks are a later addition.
- The registry fields are projected out of Koios's `token_registry_metadata` column one by
  one rather than taken as a whole object, specifically to leave the base64 `logo` behind.
  Declining to read the logo is not enough, because Koios sends it either way. One live
  asset (SNEK) answers in 74,753 bytes, of which 73,664 is the logo; with the projection
  the same row is 326 bytes. A wallet asking about a full batch of its tokens would
  otherwise pull megabytes of images only to throw them away.

## [0.8.0] - 2026-07-08

Adds the stake-pool list for the delegation browse screen.

### Added

- `GET /v1/pools?limit=&offset=&ticker=`: a neutrally-ordered page of registered pools,
  largest active stake first (no promotional ranking), each hydrated with full pool info.
  `ticker` filters by a case-insensitive substring (validated to alphanumeric so it can't
  smuggle PostgREST filter syntax upstream). Built from Koios `pool_list` + `pool_info`.
- Live preprod integration coverage: a neutral page ordered by active stake, plus a ticker
  filter.
- The e2e slice now drives both pool endpoints entirely through `/v1`: it lists the top
  pool and reads it back by id, confirming the two agree (no direct upstream calls).

### Note

- Free-text search is by ticker only. Koios `pool_list` can filter on ticker but not on
  the off-chain pool name, so name search would need a metadata index and is deferred.
- The stake ordering is computed here rather than upstream. Koios stores `active_stake` as
  a text column, so ordering on it in the query sorts lexicographically and ranks a pool
  holding 9,998,813,687 lovelace above one holding 7,682,048,683,977. The registered set is
  read in full (id and stake only, which is cheap), sorted numerically, and only the
  requested page is hydrated with full pool info. Ties break on pool id so that paging is
  stable and a pool cannot appear on two pages, or on neither.
- Pool hydration is chunked. Koios answers a `/pool_info` body carrying 100 ids with a 413,
  which both the 100-id `/v1/pools/info` batch and a full list page would have hit.

## [0.7.1] - 2026-07-09

Modernizes the backend build and CI toolchain checks.

### Changed

- Documented the Node/npm toolchain pins and the upgrade checklist for runtime,
  framework, compiler, linter, and test-runner major bumps.
- Extended the baseline CI and local `check:ci` script to cover lint, format,
  typecheck, build, unit/API contract coverage, production dependency audit, and Docker
  build checks for regular and Dependabot PRs.
- Synced package-lock metadata with the current package version.

## [0.7.0] - 2026-07-08

Closes the account-rewards parity gap with the closed backend.

### Added

- `GET /v1/account/{stake}/state` now also returns `rewardsSum` (lifetime rewards ever
  earned) and `withdrawalsSum` (lifetime rewards ever withdrawn), alongside the existing
  `rewardsAvailable` (withdrawable now). Together these cover what the wallet's account
  state needs from the closed backend's per-reward-address totals
  (`spendable`/`nonSpendable`/`withdrawals`): the identity
  `rewardsSum - withdrawalsSum == rewardsAvailable` holds, and is checked live on preprod.
  Sourced from Koios `account_info`.

### Note

- A per-epoch reward history endpoint was considered and deliberately not built: the
  wallet consumes only aggregate reward totals (one figure per reward address), so a
  per-epoch list would be new surface beyond parity rather than parity.

## [0.6.0] - 2026-07-08

Toward parity with the pool data the existing wallet reads from the closed backend.

### Added

- `POST /v1/pools/info`: given `{ poolIds: [...] }` (bech32 `pool1...`), returns normalized
  stake-pool info in input order: registration status and retiring epoch, margin, fixed
  cost, declared and live pledge, active and live stake, saturation (as a fraction of the
  cap), live delegator count, lifetime blocks minted, and off-chain metadata (name,
  ticker, homepage, description). Built from Koios `pool_info`. Malformed input is
  rejected with `400` before any upstream call, and unknown pool ids are omitted.
- Live preprod integration coverage for pool info against a currently-registered pool.
- The e2e slice reads pool info back through `/v1/pools/info` for a live registered pool
  and checks the normalized shape, exercising the endpoint on the read path.

### Note

- Estimated ROA is intentionally not included yet: it is a derived analytic (the closed
  backend sources it from cexplorer), not raw chain data. It will be computed from pool
  reward history in a later change.

## [0.5.0] - 2026-07-08

### Added

- `POST /v1/addresses/filter-used`: given a batch of addresses, returns the subset that
  have appeared on chain (been used), in input order, for receive-address discovery.
  Built from Koios `address_info`. Malformed input is rejected with `400` before any
  upstream call: each address must be a bech32 payment address (`addr` / `addr_test`).
- The e2e slice now checks filter-used after its self-payment confirms, asserting the
  payment address reads back as used and a fresh derived address as unused, and pages
  history from the pre-submit tip so the assertion holds regardless of account age.

## [0.4.0] - 2026-07-08

Toward parity with the data the existing wallet reads from the closed backend.

### Added

- `GET /v1/account/{stake}/txs` for transaction history: inputs, outputs (with native
  assets), fee, withdrawals, certificates, metadata, and block info, oldest first, with
  `?after={block}` to page forward. Built from Koios `account_txs` + `tx_info`.
- The e2e slice now reads history after its self-payment confirms and asserts the
  transaction shows up, exercising the new endpoint against the live network.

## [0.3.0] - 2026-07-08

### Added

- `e2e/`: a self-contained end-to-end vertical slice that drives the `/v1` surface on a
  real network using the same CSL the Yoroi extension pins. It derives an address, reads
  balance and UTxOs, and builds, signs, submits, and confirms a self-payment. Kept
  minimal (plain ADA, one account) and separate from the backend's own tooling and CI.
- `.github/dependabot.yml`: npm and GitHub Actions updates with a 7-14 day cooldown to
  avoid installing brand-new (potentially compromised) releases, and dev-dependency
  grouping so overlapping bumps don't open conflicting PRs.

## [0.2.0] - 2026-07-08

Completes the barebones Koios read/write surface for a wallet.

### Added

- `GET /v1/account/{stake}/state` for balance, rewards, and current pool/DRep
  delegation, keyed by stake address.
- `GET /v1/account/{stake}/utxos` for the account's UTxOs in one call, including native
  assets and inline datums.
- `POST /v1/tx/submit` to submit a signed (CBOR hex) transaction and return its hash.
- `GET /v1/tx/{hash}/status` for confirmation status.
- `BadRequestError` (400) and boundary validation of stake addresses, transaction
  hashes, and the submit body.

## [0.1.0] - 2026-07-08

Initial scaffold.

### Added

- TypeScript and Fastify service skeleton with a factory-built server for testability.
- Provider abstraction (`ChainProvider`) so chain data is served independent of the
  underlying source.
- Koios provider implementing `getTip` and `getProtocolParams`, with an injectable
  fetch for deterministic tests.
- Normalized `/v1/chain/tip` and `/v1/chain/protocol-params` endpoints, a `/health`
  liveness check, and a stable error envelope.
- Config loading with validation and per-network Koios defaults.
- Unit tests across happy, unhappy, and regression paths, plus a preprod integration
  smoke test.
- CI gates that tighten from development through to main, a semver bump check, and a
  release job that tags from `package.json`.
- Contributor docs: a code style guide covering the conventions the tooling can't
  enforce, referenced from `CONTRIBUTING.md`.
