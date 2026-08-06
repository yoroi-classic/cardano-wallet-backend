### Fixed

- Governance proposal responses now report constitutional committee votes as one-member/one-vote
  counts instead of exposing manufactured zero-lovelace voting-power fields. The optional tally is
  omitted for `NewCommittee` and `NoConfidence`, where the committee has no vote.
- Pool votes are omitted for `TreasuryWithdrawals` and `NewConstitution`, where pools have no vote.
- DRep and pool `abstainPower` includes explicitly cast abstain power and always/passive abstain
  delegation, so it can exceed the abstain vote count.
