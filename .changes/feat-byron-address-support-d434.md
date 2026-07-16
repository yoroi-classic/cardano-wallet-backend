### Added

- `POST /v1/addresses/filter-used` now accepts Byron base58 addresses alongside bech32
  (`addr`/`addr_test`), so a Byron (`cardano-bip44`) wallet can complete address discovery through
  `/v1`. Acceptance is a real decode: base58, the CBOR `[ #6.24(bytes), uint ]` shape, and a
  matching CRC32, not a relaxation that lets arbitrary non-bech32 strings through. A batch mixing
  valid Byron and valid Shelley addresses is accepted; only a malformed entry, of either kind,
  still fails the batch.
- `POST /v1/addresses/utxos` and `POST /v1/addresses/txs` read UTxOs and transaction history keyed
  by a set of addresses rather than by stake key. These serve any wallet whose addresses carry no
  resolvable stake credential (Byron, and the enterprise/pointer address types), which today means
  Byron wallets are the only ones with no other way to read their UTxOs or history through `/v1`.
  `GET /v1/account/{stake}/*` is unchanged and stays Shelley-only.
