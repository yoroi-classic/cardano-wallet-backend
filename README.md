# cardano-wallet-backend

A provider-agnostic data backend for the Yoroi Classic wallet. It exposes one stable
HTTP API and serves it from whichever Cardano data source is configured, Koios,
Blockfrost, or a bring-your-own Dingo node, so the wallet never has to care where the
data comes from.

This is early. Right now it serves the chain tip and protocol parameters from Koios,
with the rest of the surface and the other providers landing behind the same contract.

## Requirements

- Node 22+

## Quick start

```bash
npm install
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

| Method | Path                        | Returns                                          |
| ------ | --------------------------- | ------------------------------------------------ |
| GET    | `/health`                   | liveness                                         |
| GET    | `/v1/chain/tip`             | `{ block, slot, epoch, hash }`                   |
| GET    | `/v1/chain/protocol-params` | normalized protocol parameters incl. cost models |

Errors come back as `{ "error": { "code", "message" } }` with a stable status code
(`502` upstream error, `504` upstream timeout, `404` unknown route, `500` otherwise).

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
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run test           # unit tests
npm run test:coverage  # unit tests with coverage thresholds
npm run test:integration  # live preprod integration smoke test
```

## Contributing

See `CONTRIBUTING.md` for the branch flow, the CI gates, and the testing and
versioning policy.

## License

Apache-2.0.
