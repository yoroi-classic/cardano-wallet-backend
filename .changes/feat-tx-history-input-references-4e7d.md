### Added

- Transaction-history inputs now carry `txHash` and `outputIndex`, the reference of the output
  each input consumed. Address and value alone do not identify a spent output, because one
  transaction can consume two outputs with the same address and the same value, so a client
  reconstructing history had to guess or fail closed. Present on the account-keyed and
  address-keyed history reads, on both the Koios and Blockfrost providers.
