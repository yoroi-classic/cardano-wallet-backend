### Security

- **Stake keys and client IPs are no longer written to the request log.** Fastify's default log
  records the request URL and the caller's IP on the same line, and the account routes carry the
  stake key _in the URL_, so every balance refresh was writing a durable link between a wallet
  identity and a network identity. The path is now scrubbed (`/v1/account/[redacted]/utxos`) and
  the IP is not logged at all. The endpoint is still logged, so traffic is still countable.

### Added

- `GET /v1/status` returns `{ version, network, provider, chain, behindSeconds, tip }`. It answers
  `200` even when the chain source is unreachable (`chain: "down"`), so a client can tell "the
  backend is down" apart from "the backend is up but its data source is not" and show a
  maintenance notice rather than a network error. `/health` stays a pure liveness check and makes
  no upstream call.
- CORS, so the browser extension and the web build can call the API at all. `CORS_ORIGINS`
  (default `*`).
- An anonymous rate limit, per client IP: `RATE_LIMIT_MAX` (default 120) and
  `RATE_LIMIT_WINDOW_MS` (default 60000). `0` disables it. The liveness probe is exempt, because an
  instance that rate-limits its own orchestrator gets declared dead.
- Graceful shutdown. On SIGTERM the server stops accepting connections and lets in-flight requests
  finish, so a rolling deploy no longer severs a wallet mid-refresh, or mid-submit.
- `docker-compose.yml` for a preprod deployment.

### Changed

- `GET /v1/chain/tip` also returns `blockTime` (unix seconds). An absolute slot is not a
  timestamp, so without it neither a client nor `/v1/status` can say how far behind the chain is.
- A 4xx raised by the framework (a rate limit, a malformed JSON body) is now reported as that 4xx
  rather than as a `500`.
