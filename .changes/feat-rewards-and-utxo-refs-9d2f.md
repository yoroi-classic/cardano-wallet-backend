### Added

- `GET /v1/account/{stake}/rewards` returns every reward the account has earned, oldest first.
  This is the rewards graph, and it replaces the extension's `POST /api/account/rewardHistory`.
  `?after=` pages forward on the epoch a reward was **earned for**, not the epoch it became
  spendable: Cardano pays two epochs in arrears, so paging on the wrong one shifts every point on
  the graph by ten days while still looking plausible. Both epochs are in the response.
- `POST /v1/tx/utxos` resolves transaction outputs by reference (`txHash#index`), replacing the
  extension's `GET /api/txs/io/{hash}/o/{index}` and batching it, which the dApp connector needs
  when resolving a transaction's inputs.

  Unlike `/v1/account/{stake}/utxos`, an output here may be **spent**, and the response says so.
  That is the point of the endpoint rather than an incidental field: collateral must be an unspent
  output, and a wallet that reuses one it set aside earlier without re-checking builds a
  transaction the node rejects, leaving the user with an unexplained failure. A missing spent flag
  from upstream is treated as malformed rather than assumed to mean unspent.
