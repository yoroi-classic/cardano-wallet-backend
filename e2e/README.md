# e2e vertical slice

A small end-to-end harness that drives the backend's `/v1` surface against a real
network, using the same CSL primitive the Yoroi browser extension uses. Think of it as a
richer, live test suite that sits next to the software it exercises.

## What it does

The first slice keeps to the minimum that proves the path works:

1. Derive the account's payment and stake addresses from a mnemonic (CIP-1852, via CSL).
2. Read the account's state and UTxOs from the backend (`/v1/account/{stake}/...`).
3. Build and sign a simple self-payment (send a little ADA back to our own address),
   using our `/v1` protocol parameters and UTxOs to feed CSL's transaction builder.
4. Submit it (`/v1/tx/submit`) and poll until it confirms (`/v1/tx/{hash}/status`).

If the address has no spendable ADA yet, it stops after step 2 and prints the address to
fund from the faucet, so the read path is still exercised without funds.

## Why it's built this way

It uses `@emurgo/cardano-serialization-lib-nodejs` at the same version the extension pins,
and derives and signs the same way the extension does. So a transaction it builds against
our backend's data is the same shape the real wallet would produce. Getting a tx built
from our `/v1` data to submit and confirm reinforces that our data contract is complete
and correct enough to drive the real wallet's transaction building. It does not exercise
the extension's own data-fetch layer, that still moves to `/v1` separately, so this proves
the primitives and the data, not the whole extension.

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

## Scope and expansion

Deliberately minimal for now: plain ADA only, single account, self-payment. It grows in
lock-step as the backend gains features and we move toward extension and mobile parity for
v1, for example spending token UTxOs, delegation and governance certificates, and reading
transaction history once those land on `/v1`.
