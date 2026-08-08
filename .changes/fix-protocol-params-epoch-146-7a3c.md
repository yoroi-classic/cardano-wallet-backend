### Fixed

- Protocol parameters are now cached only when their epoch matches the chain tip, preventing
  stale transaction fees or limits from surviving an epoch boundary.
