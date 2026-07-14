### Added

- The price surface is reserved: `GET /v1/price/ada`, `GET /v1/price/ada/history`,
  `POST /v1/price/tokens`, `POST /v1/price/tokens/history`. The paths, request shapes and
  response shapes are final, so a client adapter can be written against them today.
- They answer `501 NOT_IMPLEMENTED`, and **never a price**. Not zero, not null, not a
  placeholder. A wallet handed a `0` renders a portfolio worth $0.00, and the user cannot tell a
  crash from an unfinished backend; one of those is a reason to panic-sell. A 501 lets a client
  render "price unavailable", which is true and harmless.
- The request is still validated before the 501, so a client integrating now is told immediately
  that it is sending the wrong shape, rather than on the day the feature is switched on.

Price is the one domain here with no on-chain source: the chain does not know what ADA is worth
in dollars. It needs a market-data provider, and that choice is still open. See #6.
