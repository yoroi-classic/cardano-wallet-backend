# cardano-wallet-backend

A provider-agnostic data backend for the Yoroi Classic wallet. It exposes one stable
HTTP API and is designed to serve it from any configured Cardano data source, so the
wallet never has to care where the data comes from.

This is early. It covers the barebones reads and writes a wallet needs (chain tip and
protocol parameters, account state and UTxOs, transaction submit and status). Koios and
Blockfrost are both wired today; a bring-your-own Dingo node is planned behind the same
contract, and selecting it fails fast until its driver lands.

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

The full contract is an OpenAPI 3.1 document, served by the instance itself:

```bash
curl localhost:3010/v1/openapi.json
```

Fetching it from the running server rather than the repository means the contract you read is, by
construction, the one that instance implements. It is also checked against the code: a test fails
if a route is added without being documented, if the spec documents a route that does not exist,
or if a response stops matching the schema it publishes. `src/http/openapi.ts` is the source.

**Every lovelace amount and token quantity is a decimal string, not a JSON number.** These values
can exceed 2^53, where `JSON.parse` silently rounds: `7682048683977123456` becomes
`7682048683977124000`, and the user is shown a wrong-but-plausible balance. Parse them with
`BigInt`.

The summary:

| Method | Path                          | Returns                                                                      |
| ------ | ----------------------------- | ---------------------------------------------------------------------------- |
| GET    | `/health`                     | liveness, no upstream call                                                   |
| GET    | `/v1/openapi.json`            | OpenAPI 3.1 contract for this running build                                  |
| GET    | `/v1/status`                  | `{ version, network, provider, serverTime, chain, behindSeconds, tip }`      |
| GET    | `/v1/config`                  | client remote config (feature flags, dApp list), served from our own fork    |
| GET    | `/v1/chain/tip`               | `{ block, slot, epoch, hash, blockTime }`                                    |
| GET    | `/v1/chain/protocol-params`   | normalized protocol parameters incl. cost models                             |
| GET    | `/v1/account/{stake}/state`   | `{ registered, balance, rewardsAvailable, rewardsSum, withdrawalsSum, ... }` |
| GET    | `/v1/account/{stake}/utxos`   | array of UTxOs incl. assets and inline datums                                |
| GET    | `/v1/account/{stake}/txs`     | transaction history (oldest first, `?after={block}`)                         |
| GET    | `/v1/account/{stake}/rewards` | per-epoch reward history, oldest first                                       |
| POST   | `/v1/addresses/filter-used`   | subset of `{ addresses: [...] }` seen on chain, in input order               |
| GET    | `/v1/pools`                   | neutral page of registered stake pools: `?limit=&offset=&ticker=`            |
| POST   | `/v1/pools/info`              | stake-pool info for `{ poolIds: [...] }`, in input order                     |
| POST   | `/v1/assets/info`             | token metadata for `{ subjects: [...] }` (registry + on-chain), input order  |
| POST   | `/v1/assets/media`            | signed NFTCDN image/metadata URLs for `{ fingerprints: [...], size? }`       |
| GET    | `/v1/assets/{fp}/image`       | 302 to a signed, resized NFTCDN image (`?size=`)                             |
| GET    | `/v1/price/ada`               | ADA fiat price and 24h change per currency, from CoinGecko                   |
| GET    | `/v1/price/ada/history`       | ADA fiat OHLC history per currency, from CoinGecko                           |
| POST   | `/v1/price/tokens`            | native-token price and activity in ADA, from GeckoTerminal                   |
| POST   | `/v1/price/tokens/history`    | native-token OHLC history in ADA, from GeckoTerminal                         |
| POST   | `/v1/tx/submit`               | `{ txHash }` from `{ "cbor": "<hex tx>" }`                                   |
| POST   | `/v1/tx/utxos`                | transaction outputs for `{ refs: ["txHash#index", ...] }`, including `spent` |
| GET    | `/v1/governance/dreps`        | neutral page of registered DReps: `?limit=&offset=`                          |
| POST   | `/v1/governance/dreps/info`   | DRep info for `{ drepIds: [...] }`, in input order                           |
| GET    | `/v1/governance/proposals`    | Conway governance actions with derived status and vote tallies               |
| GET    | `/v1/tx/{hash}/status`        | lifecycle state and pending-overlay action                                   |

Errors come back as `{ "error": { "code", "message" } }` with a stable status code
(`502` upstream error, `504` upstream timeout, `429` rate limited, `400` bad request,
`404` unknown route, `500` otherwise).

### Transaction lifecycle and pending overlays

`GET /v1/tx/{hash}/status` reports one provider-neutral lifecycle state:

- `pending` is a positive mempool observation. `unknown` is only an inconclusive absence. Both
  return `overlayAction: "retain"`; a wallet must keep spent inputs hidden and keep its pending
  change available.
- `confirmed` returns `overlayAction: "reconcile"`. Refresh authoritative current-state UTxOs and
  remove the overlay only after that state incorporates the transaction.
- `rejected` and `expired` are reserved for positive terminal proof. They return
  `overlayAction: "rollback"` and a stable `TX_REJECTED` or `TX_EXPIRED` terminal code. Raw
  provider response bodies are never returned.

Provider absence is deliberately not terminal. Koios exposes only on-chain confirmation depth, so
an unconfirmed hash is `unknown`. Hosted Blockfrost can report a transaction submitted through its
own mempool as `pending`; a miss remains `unknown`, including on compatible/self-hosted deployments
without that hosted index. Neither provider currently has durable rejection evidence or retains
enough signed validity data after mempool eviction to prove expiry. Consequently neither reports
`rejected` or `expired` today. Clients must retain overlays until a provider positively confirms a
state that permits reconciliation or rollback.

## Client migration status

The migration audit in issue #71 is not a request to recreate every Emurgo-hosted endpoint. The
`/v1` surface above covers the wallet-critical chain, account, transaction, asset, governance,
remote-config, media, and contract routes. The remaining blockers are product or provider
decisions:

- Price data is implemented: CoinGecko supplies ADA fiat prices and history, while GeckoTerminal
  supplies native-token prices and history in ADA. Production startup always wires both upstreams;
  a server built without a price provider, primarily in tests, validates the request and returns
  `501 NOT_IMPLEMENTED`.
- NFT traits are returned from `/v1/assets/info`, but trait rarity is not. Rarity needs a
  collection-wide index; it cannot be computed from a one-asset chain read.
- Catalyst endpoints (`fundInfo` and `lastBlockBySlot`) have no `/v1` replacement yet. Decide
  whether the clients still need Catalyst before adding backend surface.
- Mobile's legacy rollback-diff UTxO protocol (`tipStatus`, `utxoAtPoint`,
  `utxoDiffSincePoint`) is intentionally not implemented. Mobile needs to move to current UTxOs
  plus its own pending-transaction overlay.
- Emurgo-business endpoints such as swap fee tiers, Encryptus payout links, backend-zero wallet
  registration, and curated pool rankings should be removed or owned elsewhere rather than copied
  into this backend.

`/health` and `/v1/status` are not the same thing, and the difference matters. `/health` is
liveness for the orchestrator: it makes no upstream call and answers instantly, because a load
balancer asking "is this process alive" must not be told no merely because Koios is slow.
`/v1/status` is for the wallet, whose question is "can I trust what you are about to tell me", so
it does reach upstream and reports `chain: "ok" | "stale" | "down"`. It answers `200` even when
the chain source is unreachable, so a client can tell "the backend is down" (a network error)
apart from "the backend is up, its data source is not" (a maintenance notice).
Every state includes `serverTime`, an exact Unix timestamp in milliseconds captured when the
response is constructed, so browser clients do not need access to the HTTP `Date` header.

```json
{
  "version": "0.7.1",
  "network": "preprod",
  "provider": "koios",
  "serverTime": 1784674800123,
  "chain": "down",
  "tip": null
}
```

## Running it

```bash
docker compose up -d          # preprod on :3010
curl localhost:3010/v1/status
```

## Kubernetes

An initial Helm chart lives in `charts/cardano-wallet-backend`.

```bash
helm lint charts/cardano-wallet-backend
helm template cardano-wallet-backend charts/cardano-wallet-backend
```

Chart releases are published as OCI artifacts to
`oci://ghcr.io/yoroi-classic/charts/cardano-wallet-backend` when a chart version reaches `main`.
New GHCR packages are private by default; see the chart README for the one-time public visibility
setup, authenticated and anonymous pinned installation examples, and configuration.

See `charts/cardano-wallet-backend/README.md` for local install and secret configuration.

## Configuration

See `.env.example`. Key values:

- `NETWORK` — `mainnet` | `preprod` | `preview` (default `preprod`)
- `PROVIDER` — `koios` | `blockfrost` (`dingo` lands later)
- `KOIOS_URL` — defaults per network; `KOIOS_TOKEN` optional for higher limits
- `BLOCKFROST_URL` — defaults per network to Blockfrost's own hosted endpoint; set it only to
  point at something else (a self-hosted node in Blockfrost's compatibility mode)
- `BLOCKFROST_PROJECT_ID` — Blockfrost's auth token, sent as the `project_id` header. Required
  when `PROVIDER=blockfrost`; startup fails loudly if it is missing or blank. Get one at
  https://blockfrost.io
- `CACHE_ENABLED` — `true` (default) | `false`. Turn it off only to debug upstream: it exists
  because chain-wide reads are identical for every caller, and serving them from upstream on
  every request makes our load on the provider scale with our user count for no benefit.
- `CONFIG_URL` — where client remote config is published. Defaults to **our** fork
  (`yoroi-classic/yoroi-config`). Empty string disables `/v1/config`.
- `CORS_ORIGINS` — `*` (default) or a comma-separated list
- `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` — anonymous free tier, per client IP (default 120/min).
  `0` disables the limiter, which is only correct on a private deployment.
- `NFTCDN_SUBDOMAIN` / `NFTCDN_KEY` — optional, both or neither. Enables asset media (below).
- `PORT`, `HOST`, `LOG_LEVEL`

## Privacy

**We do not log who asked what.** A wallet backend sees, on every call, the one thing a wallet
most wants kept to itself: which addresses and which stake key belong to one person. So the
request log carries the endpoint and nothing that identifies the caller. The stake key and the
transaction hash are stripped out of the path, and the client IP is not written at all:

```
/v1/account/[redacted]/utxos
```

This is not the default behaviour of the framework, and it is not a detail. Fastify's stock
request log writes the URL and the client IP on the same line, and our account routes carry the
stake key _in the URL_, so the default is a durable record of who holds what, written on every
balance refresh. The policy lives in `src/http/logging.ts` and there is a test that fails if it
regresses.

Be clear about the limit of it. We still _see_ the stake key in order to answer the request, and
the IP in order to receive it. Not retaining that link is a real and worthwhile property; it is
not the same as never having had it. If you want that guarantee, run your own node and point this
at it. We would rather say so than imply this is more than it is.

The rate limiter keeps a per-IP counter in memory. That is transient, never written down, and
never joined to what was asked for.

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
npm run docker:smoke   # start the built image and verify its /health contract
npm run check:ci       # local mirror of the baseline CI gate
```

## Contributing

See `CONTRIBUTING.md` for the branch flow, the CI gates, and the testing and
versioning policy.

## License

Apache-2.0.
