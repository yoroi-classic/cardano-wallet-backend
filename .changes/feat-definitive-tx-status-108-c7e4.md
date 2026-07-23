### Added

- `GET /v1/tx/{hash}/status` now reports provider-neutral pending, unknown, confirmed, rejected,
  and expired lifecycle states with an explicit safe pending-overlay action.

### Security

- Transaction lifecycle responses expose only canonical status fields and sanitized terminal
  codes, never raw provider bodies or transaction material.
