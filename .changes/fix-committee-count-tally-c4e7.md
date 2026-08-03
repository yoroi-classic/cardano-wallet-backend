### Fixed

- Governance proposal responses now report constitutional committee votes as one-member/one-vote
  counts instead of exposing manufactured zero-lovelace voting-power fields. The optional tally is
  omitted for `NewCommittee` and `NoConfidence`, where the committee has no vote.
