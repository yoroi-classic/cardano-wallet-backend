### Fixed

- Transaction-status lookups canonicalize accepted hex hashes before querying upstream, so
  uppercase and mixed-case requests have the same seen/unseen result as lowercase requests.
