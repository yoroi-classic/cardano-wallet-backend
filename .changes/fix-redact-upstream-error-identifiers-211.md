### Security

- A wallet identifier carried in an upstream path no longer reaches the response body or the log.
  Koios documents `/account_txs` as GET with `_stake_address`, so an upstream failure on account
  history named the caller's stake key in its message, which the error handler returns as the 502
  body and the retry line logs at the default `LOG_LEVEL`. Stake keys, Shelley and Byron payment
  addresses and 32-byte hashes are redacted from both. Public register ids, such as a pool or DRep
  id, and the endpoint itself survive, so the failure is still diagnosable.
