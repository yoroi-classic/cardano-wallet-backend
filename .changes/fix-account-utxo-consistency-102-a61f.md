### Fixed

- Multi-page Koios account and address UTxO reads now page from a composite `tx_hash`/`tx_index`
  cursor rather than an offset, so a spend and a creation between pages can no longer produce a
  same-total snapshot with a silently shifted row.
- Paged reads no longer name the fetched page in upstream errors. The keyset cursor is one of the
  caller's own output references, and it was reaching both the 502 body and the retry log line.
