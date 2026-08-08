### Fixed

- Cache loaders that throw before returning a promise no longer leave a permanently rejected
  in-flight entry; concurrent readers still share the attempt and the next read retries normally.
