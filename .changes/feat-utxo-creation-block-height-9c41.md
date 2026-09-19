### Added

- UTxO responses now carry `blockHeight`, the height of the block that created the output.
  It is authoritative provenance from the chain, so a client can persist each output's own
  creation height instead of stamping a whole snapshot with the tip. Present on the
  account-keyed, address-keyed and by-reference UTxO reads, on both the Koios and Blockfrost
  providers.
