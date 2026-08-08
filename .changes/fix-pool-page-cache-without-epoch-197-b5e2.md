### Fixed

- Pool-list pages are no longer cached or served stale when the current epoch cannot be read,
  preventing an unkeyed page from surviving an epoch boundary. Concurrent requests still share a
  single in-flight upstream read, but successful uncached results are not retained.
