# Changelog

All notable changes to this project are recorded here. The format follows
Keep a Changelog, and the project uses semantic versioning.

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
