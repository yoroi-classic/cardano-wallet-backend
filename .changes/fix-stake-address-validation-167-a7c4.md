### Fixed

- Account routes now accept only structurally valid Shelley reward addresses for the configured
  network. Checksummed values with the wrong header, payload length, padding, HRP, or network are
  rejected as `400 BAD_REQUEST` before any chain-provider lookup. Mainnet addresses are separated
  from testnet addresses; preprod and preview both use network id `0`, so reward-address bytes do
  not distinguish those deployments. Use `/v1/status` to identify whether a deployment is preprod
  or preview.
