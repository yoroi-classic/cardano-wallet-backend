### Added

- `GET /v1/tx/{hash}/status` now exposes provider-neutral lifecycle states, including pending when
  Blockfrost positively observes a transaction in its mempool, unknown when providers have no
  positive evidence, and confirmed for on-chain transactions, with an explicit safe
  pending-overlay action. Rejected and expired remain reserved for future provider support.

### Security

- Transaction lifecycle responses expose only canonical status fields and sanitized terminal
  codes, never raw provider bodies or transaction material.
