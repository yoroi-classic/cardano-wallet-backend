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

- On `POST /v1/tx/utxos` the spent state of a **collateral** output cannot come from the transaction
  read: Blockfrost documents `consumed_by_tx` as always null on a collateral output, spent or not.
  Those outputs are resolved against the controlling address's live UTxO set instead, newest page
  first, and only they pay for the extra read. When even that cannot settle it, the reference is
  omitted from the response rather than reported unspent, because a wallet acts on `spent: false` by
  offering the output as collateral, and the node then rejects the transaction it builds.
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
