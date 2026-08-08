### Fixed

- Price-provider timeouts that occur after error headers arrive now preserve the
  `504 UPSTREAM_TIMEOUT` response while the body is streaming. A stalled `404` is no longer
  mistaken for a confirmed missing token and placed in the negative cache, and untrusted upstream
  bodies and request URLs are no longer attached to provider errors.
