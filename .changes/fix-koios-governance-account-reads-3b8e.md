### Fixed

- `GET /v1/account/{stake}/state` no longer returns 502 for a stake key with an outstanding
  governance proposal deposit. The upstream balance excludes the pending refund and is therefore
  negative for those accounts, which the response schema rejected. `balance` is now documented as
  a signed amount, and the OpenAPI pattern accepts one.
- `GET /v1/account/{stake}/rewards` no longer returns 502 for an account that has received a
  governance proposal deposit refund. `proposal_refund` is now a normalized reward kind, kept
  distinct from the stake-key deposit `refund` it is not.
