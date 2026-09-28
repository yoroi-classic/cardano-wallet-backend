# e2e vertical slice

A small end-to-end harness that drives the backend's `/v1` surface against a real
network, using CML as the Yoroi clients' migration target. The mobile and extension
clients still use CSL; this harness exercises the target library, not their current
implementation.

## What it does

The first slice keeps to the minimum that proves the path works:

1. Derive the account's payment and stake addresses from a mnemonic (CIP-1852, via CML).
2. Read the account's state and UTxOs from the backend (`/v1/account/{stake}/...`).
3. Build and sign a simple self-payment (send a little ADA back to our own address),
   using our `/v1` protocol parameters and UTxOs to feed CML's transaction builder.
4. Submit it (`/v1/tx/submit`) and poll until it confirms (`/v1/tx/{hash}/status`).

If the address has no spendable ADA yet, it stops after step 2 and prints the address to
fund from the faucet, so the read path is still exercised without funds.

## Why it's built this way

It uses `@dcspark/cardano-multiplatform-lib-nodejs` to derive an account and build and sign a
transaction from `/v1` data. A successful submission and confirmation verifies that the backend
contract can drive the CML migration target. It does not exercise the current CSL-based wallet
implementation or the extension's own data-fetch layer, which still moves to `/v1` separately.

## Run it

This is self-contained with its own dependencies, separate from the backend.

```bash
# 1. start the backend (from the repo root, in another shell)
npm run dev

# 2. from this e2e/ directory
npm install
cp .env.example .env      # set MNEMONIC (test-only) and, if needed, BACKEND_URL / NETWORK
npm start
```

Fund the printed payment address from the preprod faucet
(https://docs.cardano.org/cardano-testnets/tools/faucet) and re-run to exercise the send.

Use a throwaway, test-only mnemonic. Never point this at a mnemonic that holds real funds.

### Mainnet safety

The harness supports mainnet only for deliberate operator testing because a funded run
builds, signs, and submits a transaction that spends real ADA. A mainnet run requires both
`NETWORK=mainnet` and the exact separate opt-in `ALLOW_MAINNET_E2E=true`. Missing, empty,
or differently spelled values fail during configuration loading, before the mnemonic is
accepted or signing keys are derived. Preprod and preview do not require this opt-in.

Do not keep the mainnet opt-in in a shared `.env` file. Set it only for the individual
mainnet command after confirming that the mnemonic and backend are intended for that run.

## Scope and expansion

Deliberately minimal for now: plain ADA only, single account, self-payment. It grows in
lock-step as the backend gains features and we move toward extension and mobile parity for
v1, for example spending token UTxOs, delegation and governance certificates, and reading
transaction history once those land on `/v1`.
