### Fixed

- Multi-page Koios account UTxO reads now verify ordered output membership twice and retry rather
  than returning a same-total snapshot with a silently shifted row.
