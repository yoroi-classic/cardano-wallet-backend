### Fixed

- Pool-list pages are no longer cached or served stale when the current epoch cannot be read,
  preventing an unkeyed page from surviving an epoch boundary.
