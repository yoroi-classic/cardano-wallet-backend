### Fixed

- Koios transaction history now tolerates canonical ledger `invalid_after` strings above
  JavaScript's safe-integer range. Those optional TTL values are omitted when they cannot be
  represented by the API's number-based transaction contract, instead of making the entire
  transaction history fail as malformed upstream data.
