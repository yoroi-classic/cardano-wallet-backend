### Fixed

- Blockfrost responses can no longer expose the same native asset twice by varying the hexadecimal
  casing of its unit, including when the two spellings occur in separate UTxO rows. Identical
  spellings in separate rows remain valid because one asset can be held by multiple UTxOs.
