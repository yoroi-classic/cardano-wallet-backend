### Fixed

- `GET /v1/governance/dreps` and the DRep info read no longer return 502 on the Blockfrost
  provider. Blockfrost reports a DRep credential in CIP-129 form, a type header followed by the
  28-byte hash, and the header is now stripped so `hex` is the same 28-byte credential whichever
  provider served it. The two pseudo-DReps, which carry an empty credential, no longer fail the
  page they were always going to be filtered out of.
