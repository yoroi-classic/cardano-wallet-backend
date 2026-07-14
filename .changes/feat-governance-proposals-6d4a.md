### Added

- `GET /v1/governance/proposals` returns Conway governance actions, newest first, with the DRep,
  stake-pool and committee vote tallies as they stand. A proposal without its tally is not
  something a user can act on: "should I vote on this?" is answered by where the vote currently
  sits, not by the text alone.
- `status` is derived rather than left to the client. Upstream expresses a proposal's fate as four
  separate nullable epoch fields, and every client reimplementing the same precedence rules is
  every client getting them subtly differently. `enacted` outranks `ratified`, because a proposal
  is ratified first and enacted afterwards.
- `metadataValid` says whether the CIP-108 off-chain document matched the hash anchored on chain.
  **Absent means unknown, which is not the same as false.** A proposal's title and abstract are
  attacker-supplied text that someone reads immediately before voting, so a client has to be able
  to tell a verified document from an unverified one.
- A proposal whose tally cannot be fetched still appears, without one. A missing progress bar is a
  nuisance; a governance screen that will not load is not.
