### Added

- The Blockfrost provider now serves the transaction and UTxO reads it previously answered `501`
  for, at parity with Koios behind the same `/v1` contract:
  - `GET /v1/account/{stake}/rewards` (reward history) and `GET /v1/account/{stake}/txs`
    (transaction history). Blockfrost has no account-level transaction feed, so the history is
    assembled by enumerating the account's addresses and reading each one's transactions, deduped
    by hash and paged oldest-first on `?after=`.
  - `POST /v1/addresses/utxos` (UTxOs by address set) and `POST /v1/addresses/txs` (transaction
    history by address set).
  - `POST /v1/tx/utxos` (resolve outputs by `txHash#index`), including whether each output has since
    been spent, its inline datum, and its reference script.

  Transactions are hydrated into the same `WalletTransaction` shape Koios returns — inputs, outputs,
  amounts, withdrawals, and normalized certificates — so a client sees one shape regardless of
  provider.

### Note

- `filterUsedPaymentCredentials` remains `501` on Blockfrost: it exposes no payment-credential index
  (no equivalent of Koios's `/credential_txs`), so the read cannot be served there. A base Shelley
  wallet can use `filterUsedAddresses` with its derived addresses instead.
- Blockfrost reward history omits treasury and reserve (MIR) rewards, which Blockfrost surfaces on a
  separate resource without an earned epoch; member, leader, and deposit-refund rewards are covered.
- A transaction's `certificates` list is partial under Blockfrost: stake (de)registration, stake
  delegation, MIR, and pool registration/retirement certificates are reported, but Conway governance
  certificates (vote delegation, DRep registration/update/deregistration, committee auth/resign) are
  not, because `tx_content` carries no count for them and this API version has no per-transaction
  resource that lists them. The Koios provider reports these; parity here is a follow-up.
