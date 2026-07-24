### Fixed

- Account routes now accept only structurally valid Shelley reward addresses for the configured
  network. Checksummed values with the wrong header, payload length, padding, HRP, or network are
  rejected as `400 BAD_REQUEST` before any chain-provider lookup.
