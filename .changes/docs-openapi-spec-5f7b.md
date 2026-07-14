### Added

- The API contract is now published as an OpenAPI 3.1 document, served by the instance itself at
  `GET /v1/openapi.json`. Until now the only way to learn a response shape was to read TypeScript
  interfaces across seven files, which is not a contract anyone outside the team can build
  against, and two clients are being written against this surface right now.
- The spec cannot silently drift. One test fails if a route is registered without being
  documented, or documented without being registered; another validates real responses, from the
  real handlers, against the schemas the spec publishes. So it is checked against the
  implementation rather than merely describing it.

### Fixed

- `GET /v1/status` now returns the same `tip` object as `GET /v1/chain/tip`. It had been emitting
  a hand-picked subset with `blockTime` missing, so the API had two different objects both called
  "tip" and a client would have needed two types for one concept. Found by the spec's own
  response-validation test.
