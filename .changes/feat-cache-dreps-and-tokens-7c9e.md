### Added

- The DRep list membership is cached (two minutes), so `GET /v1/governance/dreps` stops scanning
  the whole registered set on every request. That scan exists because Koios's `registered=eq.true`
  filter fails about half the time on mainnet, forcing us to read the full list and filter here.

  The **numbers are not cached**: `votingPower` and `active` are what someone reads while deciding
  who to delegate their vote to, so the DRep info is hydrated fresh on every request. Only the
  membership (who is on the list) and the off-chain names are cached; the off-chain names get a
  long TTL because they change only when a DRep updates their metadata.

- Token metadata is cached per subject (ten minutes). The tokens a wallet holds are mostly the
  popular ones every other wallet holds too, so a second request for the same token costs nothing.
  Almost every field is fixed at mint; the one that drifts is `supply`, and ten minutes bounds
  that while the NFT-vs-fungible classification a wallet acts on never flips.

- The cache gained `peek` and `set` primitives, for the batch-load case `read` cannot express: a
  single upstream call resolves many keys at once, so the get and the store cannot wrap one loader.

### Note

- Neither cache is served stale on the numbers. Membership is held briefly past expiry on a failed
  refresh (a stale _list_ beats a 502), but a DRep's voting power and a token's supply are always
  fresh, for the same reason account reads are never cached at all.
