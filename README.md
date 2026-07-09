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
| GET    | `/v1/pools`                 | neutral page of pools (`?limit=&offset=&ticker=`), stake-desc                |
| POST   | `/v1/pools/info`            | stake-pool info for `{ poolIds: [...] }`, in input order                     |
| POST   | `/v1/tx/submit`             | `{ txHash }` from `{ "cbor": "<hex tx>" }`                                   |
| GET    | `/v1/tx/{hash}/status`      | `{ seen, confirmations }`                                                    |

Errors come back as `{ "error": { "code", "message" } }` with a stable status code
(`502` upstream error, `504` upstream timeout, `400` bad request, `404` unknown route,
`500` otherwise).

## Configuration

See `.env.example`. Key values:

- `NETWORK` — `mainnet` | `preprod` | `preview` (default `preprod`)
- `PROVIDER` — `koios` (others land soon)
- `KOIOS_URL` — defaults per network; `KOIOS_TOKEN` optional for higher limits
- `PORT`, `HOST`, `LOG_LEVEL`

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
