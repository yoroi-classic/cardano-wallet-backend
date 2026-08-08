### Fixed

- Address-keyed transaction history now stops paging once its first transaction window and
  boundary block are complete, rather than fetching every matching row for active addresses.
