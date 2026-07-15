### Fixed

- `GET /v1/pools` no longer fails a quarter of the time on mainnet, and no longer takes twenty
  seconds when it works. Measured against live mainnet before this change: 18-21 seconds per
  request and one in four returning a 504. After: 8.4 seconds cold, then instant, six out of six.
- The cause was not a slow endpoint but a **bimodal** one. Koios `/pool_info` answers in about 7.5
  seconds on a fast instance and in 22 to 52 on a slow one, so our 10-second timeout was cutting
  off requests that were about to succeed and forcing a retry. Heavy endpoints now get a 15-second
  budget, chosen to sit _between_ the two modes: a fast instance is never cut off, and a slow one
  is still abandoned quickly enough that the retry can land somewhere else.

### Added

- The pool ranking is cached on the **epoch number**, because that is what `active_stake` is: the
  snapshot the ledger uses for rewards, fixed for five days and then moving all at once. The full
  registered-set scan now happens once per epoch instead of once per request.
- A served page is cached for 90 seconds. The hydrated rows carry `liveStake` and `saturation`,
  which drift continuously and are the numbers someone reads while choosing a pool, so they are
  deliberately **not** cached on the epoch.
- If a refresh fails, the last good page is served rather than an error, for up to ten minutes. A
  saturation figure two minutes old is worth immeasurably more to the person choosing a pool than
  an error page is. A failure does not extend the window, so a real outage still surfaces as one.

### Note

- Stale-on-error is off by default and is **never** set on an account-scoped read. A stale balance
  or UTxO set handed to a wallet that is about to build a transaction produces a failed submission
  or a double-spend, and "upstream was down" is not a licence to guess at someone's money.
