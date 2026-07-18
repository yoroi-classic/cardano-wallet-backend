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

### Fixed

- Byron acceptance now decodes the tagged payload and validates the full address body
  `[addressRoot, addressAttributes, addressType]`, not just the outer CBOR envelope and its CRC32.
  The envelope alone is forgeable: any CBOR value wrapped in the accepted `[ #6.24(bytes), uint ]`
  shape with a recomputed checksum used to pass. A non-Byron inner value, a wrong-length address
  root, or trailing bytes are now rejected.
- The address-keyed UTxO and history reads follow Koios/PostgREST `Content-Range` paging instead
  of stopping at the upstream 1,000-row cap, so a wallet with more than 1,000 matching UTxOs or
  transactions no longer silently loses everything past the first page. UTxO pages are read in a
  stable order and deduplicated by output reference; history pages are read oldest-first on a
  block-boundary cursor so nothing is skipped.
- `POST /v1/addresses/utxos` deduplicates a repeated address in the request set before reading, so
  a batch large enough to split across upstream requests can no longer return the same UTxO twice.
