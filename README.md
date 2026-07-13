# cardano-wallet-backend

A provider-agnostic data backend for the Yoroi Classic wallet. It exposes one stable
HTTP API and is designed to serve it from any configured Cardano data source, so the
wallet never has to care where the data comes from.

This is early. It covers the barebones reads and writes a wallet needs (chain tip and
protocol parameters, account state and UTxOs, transaction submit and status), and Koios
is the only wired provider. Blockfrost and a bring-your-own Dingo node are planned
behind the same contract, and selecting them today fails fast until their drivers land.

## Requirements

- Node 22.x (see `.nvmrc` and `package.json` `engines`)
- npm 10.9.7 (see `package.json` `packageManager`)
- Docker, when running the local Docker build check

## Quick start

```bash
npm ci
cp .env.example .env      # defaults to preprod via public Koios
npm run dev               # starts the server with reload
```

Then:

```bash
curl localhost:3010/health
curl localhost:3010/v1/chain/tip
curl localhost:3010/v1/chain/protocol-params
```

## API

| Method | Path                        | Returns                                                                      |
| ------ | --------------------------- | ---------------------------------------------------------------------------- |
| GET    | `/health`                   | liveness                                                                     |
| GET    | `/v1/chain/tip`             | `{ block, slot, epoch, hash }`                                               |
| GET    | `/v1/chain/protocol-params` | normalized protocol parameters incl. cost models                             |
| GET    | `/v1/account/{stake}/state` | `{ registered, balance, rewardsAvailable, rewardsSum, withdrawalsSum, ... }` |
| GET    | `/v1/account/{stake}/utxos` | array of UTxOs incl. assets and inline datums                                |
| GET    | `/v1/account/{stake}/txs`   | transaction history (oldest first, `?after={block}`)                         |
| POST   | `/v1/addresses/filter-used` | subset of `{ addresses: [...] }` seen on chain, in input order               |
| POST   | `/v1/pools/info`            | stake-pool info for `{ poolIds: [...] }`, in input order                     |
| POST   | `/v1/assets/info`           | token metadata for `{ subjects: [...] }` (registry + on-chain), input order  |
| POST   | `/v1/assets/media`          | signed NFTCDN image/metadata URLs for `{ fingerprints: [...], size? }`       |
| GET    | `/v1/assets/{fp}/image`     | 302 to a signed, resized NFTCDN image (`?size=`)                             |
| POST   | `/v1/tx/submit`             | `{ txHash }` from `{ "cbor": "<hex tx>" }`                                   |
| GET    | `/v1/governance/dreps`      | neutral page of registered DReps: `?limit=&offset=`                          |
| POST   | `/v1/governance/dreps/info` | DRep info for `{ drepIds: [...] }`, in input order                           |
| GET    | `/v1/tx/{hash}/status`      | `{ seen, confirmations }`                                                    |

Errors come back as `{ "error": { "code", "message" } }` with a stable status code
(`502` upstream error, `504` upstream timeout, `400` bad request, `404` unknown route,
`500` otherwise).

## Configuration

See `.env.example`. Key values:

- `NETWORK` — `mainnet` | `preprod` | `preview` (default `preprod`)
- `PROVIDER` — `koios` (others land soon)
- `KOIOS_URL` — defaults per network; `KOIOS_TOKEN` optional for higher limits
- `CACHE_ENABLED` — `true` (default) | `false`. Turn it off only to debug upstream: it exists
  because chain-wide reads are identical for every caller, and serving them from upstream on
  every request makes our load on the provider scale with our user count for no benefit.
- `NFTCDN_SUBDOMAIN` / `NFTCDN_KEY` — optional, both or neither. Enables asset media (below).
- `PORT`, `HOST`, `LOG_LEVEL`

### Asset media

`/v1/assets/info` returns a token's `image` as whatever URI the minter put on chain, which is
usually `ipfs://`, sometimes `ar://`, and occasionally broken. None of that is renderable without
a gateway and none of it is sized: a gallery of a hundred NFTs would pull a hundred
full-resolution originals, some of them megabytes of animated GIF, onto a phone.

With NFTCDN configured, `POST /v1/assets/media` returns signed, resized image URLs for up to 100
assets in one call. **Call that, not the redirect, for a gallery.** `GET /v1/assets/{fp}/image` is
a convenience 302 for a single asset; used per tile it would cost one request to us for every
thumbnail on the screen, which at the default rate limit a single scroll would nearly exhaust.

The signing key never leaves the backend. A key shipped inside an extension or an app would be
extracted within the hour, and whoever pulled it could serve their own bandwidth on our account.

NFTCDN serves powers of two (32 to 1024). The Yoroi apps ask for 720, which is not one, so a
requested size is rounded **up** to a size that exists and the response says which size it
actually served. Rounding down would hand the client a 512 to upscale into a blurry tile, and the
user would conclude the wallet is broken.

Without a key, media answers `503 FEATURE_UNAVAILABLE` and everything else works.

### What is cached

Chain-wide reads only, and every account-scoped read is deliberately excluded. Account state,
UTxOs, transaction history, and transaction status are per-user and always fresh: serving a
stale balance or a stale UTxO set to a wallet that is about to build a transaction produces a
failed submission or a double-spend. The whole policy lives in `src/providers/cached.ts`, and
anything not listed there is not cached.

Protocol parameters are keyed on the epoch number rather than on a duration, because that is
what they are: fixed within an epoch, and changed at the boundary.

## Scripts

```bash
npm run dev            # dev server with reload
npm run build          # compile to dist/
npm start              # run the compiled server
npm run format:check   # verify Prettier formatting
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run test           # unit and API contract tests
npm run test:contract  # API contract tests only
npm run test:coverage  # unit and API contract tests with coverage thresholds
npm run test:integration  # live preprod integration smoke test
npm run audit:prod     # production dependency audit
npm run docker:build   # Docker image build check
npm run check:ci       # local mirror of the baseline CI gate
```

## Contributing

See `CONTRIBUTING.md` for the branch flow, the CI gates, and the testing and
versioning policy.

## License

Apache-2.0.
