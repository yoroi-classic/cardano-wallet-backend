### Fixed

- Koios rows with odd-length asset-name hex are rejected as malformed instead of being exposed as
  valid native assets; empty names and complete byte-pair hex remain accepted.
