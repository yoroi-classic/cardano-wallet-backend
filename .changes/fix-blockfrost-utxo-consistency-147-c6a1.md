### Fixed

- Multi-page Blockfrost account UTxO reads now require two consecutive ordered membership scans
  to agree, so offset shifts cannot silently return incomplete spendable state.
