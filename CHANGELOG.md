# Changelog

All notable changes to this project are recorded here. The format follows
Keep a Changelog, and the project uses semantic versioning.

## [0.8.0] - 2026-09-12

Promotes the reviewed development API and operational changes to preview.

### Added

- CI scans the built image for known vulnerabilities and fails on HIGH or CRITICAL findings **that
  have a fix available**. Unfixed advisories are ignored on purpose: a Debian slim image always
  carries a tail of those, and a gate nobody can pass is a gate somebody eventually deletes.
- `npm run docker:scan` runs the same check locally, and `npm run check:ci` includes it, so a red
  build is reproducible rather than a mystery.
- Publish versioned `cardano-wallet-backend` Helm charts as OCI artifacts in GHCR when chart
  changes reach `main`.
- Cancel superseded Helm validation for pull requests and non-main branches without dropping
  validation or queued publication within GitHub Actions' 100-run concurrency-group limit.
- The API contract is now published as an OpenAPI 3.1 document, served by the instance itself at
  `GET /v1/openapi.json`. Until now the only way to learn a response shape was to read TypeScript
  interfaces across seven files, which is not a contract anyone outside the team can build
  against, and two clients are being written against this surface right now.
- The spec cannot silently drift. One test fails if a route is registered without being
  documented, or documented without being registered; another validates real responses, from the
  real handlers, against the schemas the spec publishes. So it is checked against the
  implementation rather than merely describing it.
- `PROVIDER=blockfrost` is now a real option (`BLOCKFROST_URL`, `BLOCKFROST_PROJECT_ID`),
  covering chain tip and protocol parameters, stake-account state and UTxOs, the used-address
  check, and transaction submit/status behind the same `/v1` contract Koios serves. Asset,
  governance, and pool reads, plus full transaction/reward history and UTxO-by-reference
  resolution, are not yet implemented on this provider and answer `501` until a follow-up
  lands.
- The Blockfrost provider now answers the reference-data reads that previously returned
  `NotImplementedError`, matching the Koios provider's output shape:
  - `GET /v1/assets/info` (asset metadata), from `/assets/{asset}`. Off-chain CIP-26 registry
    projection is preferred, then Blockfrost's decoded on-chain metadata (CIP-25 traits, or a
    CIP-68 datum resolved server-side), then `source: "none"`. Chunked CIP-25 name, description,
    image, and url values are re-joined.
  - `POST /v1/governance/dreps/info` and `GET /v1/governance/dreps`, from `/governance/dreps`
    and `/governance/dreps/{drep_id}`. Neutral, unranked list, no house DRep. Off-chain CIP-119
    names/images resolved best-effort.
  - `GET /v1/governance/proposals`, from `/governance/proposals`, newest first, with CIP-108
    title/abstract resolved best-effort.
  - `POST /v1/pools/info` and `GET /v1/pools`, from `/pools/{pool_id}` and `/pools/extended`,
    with `/pools/retiring` consulted so a scheduled retirement is reported as `retiring` (with
    its `retiringEpoch`) rather than `retired`. Neutral list ordered by active stake, largest
    first, honoring the `ticker` filter and cached per epoch like the Koios pool ranking.
- The Blockfrost provider now serves the transaction and UTxO reads it previously answered `501`
  for, at parity with Koios behind the same `/v1` contract:
  - `GET /v1/account/{stake}/rewards` (reward history) and `GET /v1/account/{stake}/txs`
    (transaction history). Blockfrost has no account-level transaction feed, so the history is
    assembled by enumerating the account's addresses and reading each one's transactions, deduped
    by hash and paged oldest-first on `?after=`.
  - `POST /v1/addresses/utxos` (UTxOs by address set) and `POST /v1/addresses/txs` (transaction
    history by address set).
  - `POST /v1/tx/utxos` (resolve outputs by `txHash#index`), including whether each output has since
    been spent, its inline datum, and its reference script.

  Transactions are hydrated into the same `WalletTransaction` shape Koios returns — inputs, outputs,
  amounts, withdrawals, and normalized certificates — so a client sees one shape regardless of
  provider.

- `POST /v1/addresses/filter-used` now accepts Byron base58 addresses alongside bech32
  (`addr`/`addr_test`), so a Byron (`cardano-bip44`) wallet can complete address discovery through
  `/v1`. Acceptance is a real decode: base58, the CBOR `[ #6.24(bytes), uint ]` shape, and a
  matching CRC32, not a relaxation that lets arbitrary non-bech32 strings through. A batch mixing
  valid Byron and valid Shelley addresses is accepted; only a malformed entry, of either kind,
  still fails the batch.
- `POST /v1/addresses/utxos` and `POST /v1/addresses/txs` read UTxOs and transaction history keyed
  by a set of addresses rather than by stake key. These serve any wallet whose addresses carry no
  resolvable stake credential (Byron, and the enterprise/pointer address types), which today means
  Byron wallets are the only ones with no other way to read their UTxOs or history through `/v1`.
  `GET /v1/account/{stake}/*` is unchanged and stays Shelley-only.
- The DRep list membership is cached (two minutes), so `GET /v1/governance/dreps` stops scanning
  the whole registered set on every request. That scan exists because Koios's `registered=eq.true`
  filter fails about half the time on mainnet, forcing us to read the full list and filter here.

  The **numbers are not cached**: `votingPower` and `active` are what someone reads while deciding
  who to delegate their vote to, so the DRep info is hydrated fresh on every request. Only the
  membership (who is on the list) and the off-chain names are cached; the off-chain names get a
  long TTL because they change only when a DRep updates their metadata.

- Token metadata is cached per subject (ten minutes). The tokens a wallet holds are mostly the
  popular ones every other wallet holds too, so a second request for the same token costs nothing.
  Almost every field is fixed at mint; the one that drifts is `supply`, and ten minutes bounds
  that while the NFT-vs-fungible classification a wallet acts on never flips.

- The cache gained `peek` and `set` primitives, for the batch-load case `read` cannot express: a
  single upstream call resolves many keys at once, so the get and the store cannot wrap one loader.
- `GET /v1/tx/{hash}/status` now exposes provider-neutral lifecycle states, including pending when
  Blockfrost positively observes a transaction in its mempool, unknown when providers have no
  positive evidence, and confirmed for on-chain transactions, with an explicit safe
  pending-overlay action. Rejected and expired remain reserved for future provider support.
- `GET /v1/governance/proposals` returns Conway governance actions, newest first, with the DRep,
  stake-pool and committee vote tallies as they stand. A proposal without its tally is not
  something a user can act on: "should I vote on this?" is answered by where the vote currently
  sits, not by the text alone.
- `status` is derived rather than left to the client. Upstream expresses a proposal's fate as four
  separate nullable epoch fields, and every client reimplementing the same precedence rules is
  every client getting them subtly differently. `enacted` outranks `ratified`, because a proposal
  is ratified first and enacted afterwards.
- `metadataValid` says whether the CIP-108 off-chain document matched the hash anchored on chain.
  **Absent means unknown, which is not the same as false.** A proposal's title and abstract are
  attacker-supplied text that someone reads immediately before voting, so a client has to be able
  to tell a verified document from an unverified one.
- A proposal whose tally cannot be fetched still appears, without one. A missing progress bar is a
  nuisance; a governance screen that will not load is not.
- `POST /v1/assets/info` returns metadata for a batch of native tokens by CIP-26 subject.
  Display fields are resolved from the CIP-26 off-chain token registry first, then CIP-25
  on-chain mint metadata (the usual NFT case), then a CIP-68 reference-token datum, and
  `source` says which one supplied them. On-chain basics (fingerprint, supply, names)
  always apply. Sourced from Koios.
- `GET /v1/governance/dreps` returns a neutral, unranked page of registered DReps, ordered
  by id. No promotional ranking and no house DRep.
- `POST /v1/governance/dreps/info` returns info for a batch of DReps by bech32 id. Both the
  current CIP-129 form and the deprecated CIP-105 form are accepted on the way in; CIP-129
  is always what gets emitted. Off-chain CIP-119 names and images are resolved best-effort.
  A DRep the chain has never heard of comes back with `status: "not_registered"` rather than
  being dropped, so a caller can tell that apart from a failed lookup.
- `GET /v1/pools` returns a page of registered stake pools ordered by active stake, largest
  first, with ties broken by pool id so paging is stable, and an optional case-insensitive
  `ticker` filter. Neutral by construction: no promotional ranking and no house pool.
  `limit` and `offset` are validated as plain integers rather than coerced, so `?offset=1e3`
  or `?offset=0x10` is a 400 rather than being quietly read as 1000 or 16. Sourced from
  Koios.
- `POST /v1/assets/info` now returns NFT `traits`: the collection-specific attributes a minter
  attached, e.g. `{"background": "Seafoam Green", "accessories": "Spider"}`. Replaces the
  dullahan `GET /tokens/nft/traits/{tokenId}`.
- They cost **no extra upstream call**: the traits were already inside the CIP-25 metadata this
  endpoint fetches, so there is no new endpoint and no new round trip. A client that already reads
  token metadata gets them for free.
- Traits are what the spec did **not** reserve. CIP-25 defines `name`, `image`, `description`,
  `mediaType` and `files` and says nothing about the rest of the map, so a minter's traits are
  simply whatever is left over. We subtract rather than allowlist, because any allowlist would
  silently drop the traits of the next collection to mint.
- No rarity. "2% of the collection has Spider" cannot be computed from one asset: it needs every
  asset in the policy, which for a large collection is over a hundred upstream calls. That is an
  indexing job, not a request, and it is tracked separately.
- Signed NFTCDN media URLs for native assets. `POST /v1/assets/media` returns a signed, resized
  image URL (and a metadata URL) for up to 100 asset fingerprints in one call; `GET
/v1/assets/{fingerprint}/image?size=` 302s to the signed URL for a single asset.
- Until now `/v1/assets/info` handed clients the raw on-chain image URI, usually `ipfs://`, which
  is not renderable without a gateway and not sized: an NFT gallery would pull a hundred
  full-resolution originals onto a phone.
- The signing key never leaves the backend. A client holding it could be decompiled within the
  hour, and whoever pulled the key could serve their own bandwidth on our account.
- A requested size is rounded **up** to one NFTCDN actually serves (it serves powers of two; the
  Yoroi apps ask for 720, which is not one), and the response reports the size actually served.
- Configured with `NFTCDN_SUBDOMAIN` and `NFTCDN_KEY`, both or neither. Without them the media
  routes answer `503 FEATURE_UNAVAILABLE`, naming the fallback, and every other endpoint works.
- The pool ranking is cached on the **epoch number**, because that is what `active_stake` is: the
  snapshot the ledger uses for rewards, fixed for five days and then moving all at once. The full
  registered-set scan now happens once per epoch instead of once per request.
- A served page is cached for 90 seconds. The hydrated rows carry `liveStake` and `saturation`,
  which drift continuously and are the numbers someone reads while choosing a pool, so they are
  deliberately **not** cached on the epoch.
- If a refresh fails, the last good page is served rather than an error, for up to ten minutes. A
  saturation figure two minutes old is worth immeasurably more to the person choosing a pool than
  an error page is. A failure does not extend the window, so a real outage still surfaces as one.
- The price surface (#6) now answers for real, instead of the `501` stub reserved for it:
  - `GET /v1/price/ada` — ADA's fiat price and 24h change, per currency, from CoinGecko.
  - `GET /v1/price/ada/history` — ADA OHLC candles, from CoinGecko.
  - `POST /v1/price/tokens` — native-token price, 24h/7d/30d change, and volume, **in ADA**, from
    GeckoTerminal (a CoinGecko product). This is mobile's only source of a primary-token price.
  - `POST /v1/price/tokens/history` — a token's OHLC price chart, in ADA, from GeckoTerminal.

  Both upstreams are public and keyless at the tier used here. `COINGECKO_API_KEY` is an optional
  new config field for a higher CoinGecko rate limit; unset works fine.

- Every native-token price is read from the pool that pairs the token **directly with ADA**, never
  guessed at through a stablecoin pool and a separate fiat conversion. A token with no such pool
  (no real liquidity, or one GeckoTerminal has never indexed) is reported as unavailable: omitted
  from the `/v1/price/tokens` batch, or an empty candle list from the history endpoint. Never a
  price of zero.

- An upstream failure (a timeout, a 5xx, a malformed body) still surfaces as the usual `502`/`504`,
  never a fake number. The one rule this whole surface existed to enforce even as a stub, carried
  over unchanged now that it has a real provider behind it.

- Cached (#47): a live ADA price or token quote for a minute, OHLC history for five. Every wallet
  asking the same question gets the same cached answer, so call volume against CoinGecko and
  GeckoTerminal does not scale with users.
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
- `GET /v1/config` serves the client remote configuration (feature flags, the dApp list) from
  **our own fork**, `yoroi-classic/yoroi-config`, replacing the clients' direct fetch of a JSON
  file from Emurgo's repository.

  The endpoint is not the point; whose file it is, is. Whoever controls that document controls
  what our users see: a banner, the dApp list, or nothing at all if it is deleted. A wallet
  asking us rather than a host we do not control is what makes the fork mean something.

  It also stops a wallet handing its IP to a third-party git host on every launch, which sits
  oddly beside the trouble we take not to write that down ourselves.

- The document is served **verbatim**, with no transformation. A config endpoint that rewrites
  config becomes a second place to look when a client misbehaves, and nobody remembers to look in
  two places. The Emurgo banners are already switched off in the fork, which is where a content
  decision belongs.

- Cached for five minutes, and served for up to a day if a refresh fails. A wallet that cannot
  finish starting because a git host is having a bad morning is a bad wallet, and a day-old
  feature flag is very unlikely to be wrong. A failure never refreshes the timestamp, so a long
  outage still surfaces as an error rather than serving last month's config forever.

- `CONFIG_URL` overrides the source; an empty string turns the endpoint off (it answers `503`).
- Chain-wide reads are now cached in process, with request coalescing. `GET /v1/chain/tip` and
  `GET /v1/chain/protocol-params` are identical for every caller, and were being fetched from
  upstream on every single request, so the load we put on the provider grew with our user count
  for no benefit. Measured against live Koios, 20 concurrent clients reading both endpoints now
  cost 2 upstream calls rather than 40, and that number stays flat as clients are added.
- `CACHE_ENABLED` (default `true`) turns it off, for debugging upstream.
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

- `GET /v1/status` includes an exact Unix millisecond `serverTime` in every chain state.

### Changed

- `Proposal.proposedEpoch` is now optional. Koios still reports it; Blockfrost exposes no proposed
  epoch and only the current `gov_action_lifetime`, which cannot correctly date a historical
  proposal, so it is left absent rather than derived from a possibly-changed parameter.
- `GET /v1/chain/tip` also returns `blockTime` (unix seconds). An absolute slot is not a
  timestamp, so without it neither a client nor `/v1/status` can say how far behind the chain is.
- A 4xx raised by the framework (a rate limit, a malformed JSON body) is now reported as that 4xx
  rather than as a `500`.
- Batch requests to Koios are packed against the documented 5,120-byte body limit instead of a
  fixed item count. The counts we used (50 pool ids, 50 DRep ids, 20 asset subjects) were each
  arrived at by bisecting against a 413, and they left most of the budget unused: 84 pool ids fit
  where we were sending 50, so hydrating a page of the pool list now takes 3 upstream requests
  rather than 5, verified against live mainnet. Chunks of one batch are also sent concurrently
  rather than one after another.

### Fixed

- `GET /v1/status` now returns the same `tip` object as `GET /v1/chain/tip`. It had been emitting
  a hand-picked subset with `blockTime` missing, so the API had two different objects both called
  "tip" and a client would have needed two types for one concept. Found by the spec's own
  response-validation test.
- Byron acceptance now decodes the tagged payload and validates the full address body
  `[addressRoot, addressAttributes, addressType]`, not just the outer CBOR envelope and its CRC32.
  The envelope alone is forgeable: any CBOR value wrapped in the accepted `[ #6.24(bytes), uint ]`
  shape with a recomputed checksum used to pass. A non-Byron inner value, a wrong-length address
  root, or trailing bytes are now rejected.
- The address-keyed UTxO and history reads follow Koios/PostgREST `Content-Range` paging instead
  of stopping at the upstream 1,000-row cap, so a wallet with more than 1,000 matching UTxOs or
  transactions no longer silently loses everything past the first page. UTxO pages are read in a
  stable order and deduplicated by output reference; history pages are read oldest-first on a
  block-boundary cursor so nothing is skipped. They pack the address set against the body budget
  through the same primitive as the other batched reads, so a self-hosted or proxied Koios that
  advertises a smaller body cap with a 413 is adapted to (the limit is lowered and the set
  repacked) rather than surfacing as a 502.
- `POST /v1/addresses/utxos` deduplicates a repeated address in the request set before reading, so
  a batch large enough to split across upstream requests can no longer return the same UTxO twice.
- CIP-68 version-4 assets resolve their metadata. Version 4 wraps it in a CIP-25-shaped
  nested map under a `721` key; walking it as if it were version 1 found none of the fields
  and reported the asset as having no metadata at all.
- CIP-68 values split across a list of byte strings (which the spec requires for anything
  over 64 bytes, so most image URIs) are joined rather than dropped.
- A bech32 pool id whose checksum passes but whose 5-bit payload does not convert back to
  bytes is now a 400 from `POST /v1/pools/info` rather than a 500.
- `GET /v1/pools` no longer fails a quarter of the time on mainnet, and no longer takes twenty
  seconds when it works. Measured against live mainnet before this change: 18-21 seconds per
  request and one in four returning a 504. After: 8.4 seconds cold, then instant, six out of six.
- The cause was not a slow endpoint but a **bimodal** one. Koios `/pool_info` answers in about 7.5
  seconds on a fast instance and in 22 to 52 on a slow one, so our 10-second timeout was cutting
  off requests that were about to succeed and forcing a retry. Heavy endpoints now get a 15-second
  budget, chosen to sit _between_ the two modes: a fast instance is never cut off, and a slow one
  is still abandoned quickly enough that the retry can land somewhere else.
- Koios account-state reads now reject mismatched or duplicate account rows instead of returning
  another stake address's balance and delegation state.
- Koios account state accepts signed balances while proposal deposits are outstanding.
- Koios `proposal_refund` rewards are normalized to the public `refund` kind.
- Multi-page Koios account and address UTxO reads now page from a composite `tx_hash`/`tx_index`
  cursor rather than an offset, so a spend and a creation between pages can no longer produce a
  same-total snapshot with a silently shifted row.
- Paged reads no longer name the fetched page in upstream errors. The keyset cursor is one of the
  caller's own output references, and it was reaching both the 502 body and the retry log line.
- Address-keyed transaction history now stops paging once its first transaction window and
  boundary block are complete, rather than fetching every matching row for active addresses.
- Blockfrost responses can no longer expose the same native asset twice by varying the hexadecimal
  casing of its unit, including when the two spellings occur in separate UTxO rows. Identical
  spellings in separate rows remain valid because one asset can be held by multiple UTxOs.
- Authenticated Blockfrost integration discovery now rejects redirects instead of forwarding its
  `project_id` credential to the redirect target.
- Multi-page Blockfrost account UTxO reads now require two consecutive ordered membership scans
  to agree, so offset shifts cannot silently return incomplete spendable state.
- Cache loaders that throw before returning a promise no longer leave a permanently rejected
  in-flight entry; concurrent readers still share the attempt and the next read retries normally.
- A token whose CIP-25 mint metadata is keyed by the raw hex asset name, but which declares no
  `version`, now resolves its name and image instead of coming back as `source: "none"`. CIP-25
  says an undeclared version means version 1, which keys the map by the asset name as UTF-8
  text, but minters key by hex anyway: 21 assets sampled on preprod do exactly this, and their
  names are 32-byte hashes that are not valid UTF-8, so no text key could ever have matched.
  Those tokens had no registry entry and no CIP-68 datum either, so they rendered with no name
  and no image at all. The spec-implied key is still tried first, and only a miss falls through
  to the other form, so an asset can never be handed a sibling's metadata.
- ADA price reads now tolerate CoinGecko's nullable price-change and freshness fields while still
  returning only finite numeric market values.
- Governance proposal responses now report constitutional committee votes as one-member/one-vote
  counts instead of exposing manufactured zero-lovelace voting-power fields. The optional tally is
  omitted for `NewCommittee` and `NoConfidence`, where the committee has no vote.
- Pool votes are omitted for `TreasuryWithdrawals` and `NewConstitution`, where pools have no vote.
- DRep and pool `abstainPower` includes explicitly cast abstain power and always/passive abstain
  delegation, so it can exceed the abstain vote count.
- Invalid remote-config URLs and blank NFTCDN settings now fail during startup instead of breaking
  wallet configuration or signed media requests after deployment.
- E2E self-payments restrict coin selection to ADA outputs at the address whose payment key the
  harness derives, so account-wide UTxOs cannot introduce an input the harness cannot sign.
- E2E pool discovery now surfaces Koios HTTP failures before parsing the response, without
  copying upstream error bodies or configured URL credentials into its error message.
- GeckoTerminal request pacing now caps the number of queued calls released after an event-loop
  stall, preventing delayed timers from exceeding the configured upstream burst limit.
- Helm deployments using the Blockfrost provider now read the required project ID from an
  operator-managed Kubernetes Secret and can configure an optional Blockfrost base URL.
- Factory-created chain providers now honor the process cache injected by the application instead
  of allocating a second store. Provider entries are scoped by driver and network, while
  standalone construction keeps its configured private-cache or no-cache fallback.
- Clearing a provider namespace also invalidates in-flight batch metadata writes, so a response
  that started before the clear cannot repopulate the namespace afterward.
- Koios rows with odd-length asset-name hex are rejected as malformed instead of being exposed as
  valid native assets; empty names and complete byte-pair hex remain accepted.
- An `asset_info` batch can no longer exceed the upstream body limit. A subject is a policy id
  plus an asset name of 0 to 64 hex chars, so it is variable length, and chunking it by a fixed
  count of 20 was safe only because 20 worst-case subjects happened to fit. Nothing enforced
  that. Packing measures the real serialized body, so it is safe by construction.
- If upstream rejects a body with a 413 that names a smaller limit than we packed to (a proxy, or
  a self-hosted Koios with a tighter cap), that limit is adopted, the items are repacked, and the
  batch is retried once. Previously it took a redeploy.
- Invalid Koios retry, timeout, backoff, and request-body limits are rejected when the provider is
  constructed. Safe integer and timer-range bounds prevent malformed values from turning bounded
  retries into an effectively endless request or disabling request-size protection.
- An upstream read that comes back off-spec is now retried before it is surfaced as an
  error. Some of the instances behind `api.koios.rest` intermittently answer with responses
  that do not match Koios's own API spec (a null `active` on `/drep_info`, a phantom
  `registered` column on a filtered `/drep_list`), which previously failed a fraction of
  `GET /v1/governance/dreps` requests through no fault of the caller. Reads get three
  attempts with a short linear backoff, and each retry is logged, so an unhealthy upstream
  is visible rather than silent.
- Koios tip responses with negative, fractional, or unsafe-number chain counters are now rejected
  as malformed upstream data.
- Koios transaction history now tolerates canonical ledger `invalid_after` strings above
  JavaScript's safe-integer range. Those optional TTL values are omitted when they cannot be
  represented by the API's number-based transaction contract, instead of making the entire
  transaction history fail as malformed upstream data.
- Oversized market-data decimal operands are rejected before division, preventing non-finite
  operands from being reported as fabricated token volumes.
- OpenAPI contract tests now invoke the callable `ajv-formats` default import directly instead of
  depending on its current CommonJS build also attaching a redundant nested `.default` property.
- Address-set routes now reject malformed Shelley payloads and addresses from a different
  configured network before forwarding them to a chain provider.
- Token charts and 7d/30d activity are now cached against the selected ADA pool as well as the
  asset and range. A liquidity-driven pool change fetches that market's candles immediately
  instead of serving the superseded pool for the remainder of the history TTL.
- Pool-list pages are no longer cached or served stale when the current epoch cannot be read,
  preventing an unkeyed page from surviving an epoch boundary. Concurrent requests still share a
  single in-flight upstream read, but successful uncached results are not retained.
- Price-provider timeouts that occur after error headers arrive now preserve the
  `504 UPSTREAM_TIMEOUT` response while the body is streaming. A stalled `404` is no longer
  mistaken for a confirmed missing token and placed in the negative cache, and untrusted upstream
  bodies and request URLs are no longer attached to provider errors.
- Governance proposal pages now use a unique secondary order so actions from the same block cannot
  duplicate or disappear across offset page boundaries.
- Protocol parameters are now cached only when their epoch matches the chain tip, preventing
  stale transaction fees or limits from surviving an epoch boundary.
- Account routes now accept only structurally valid Shelley reward addresses for the configured
  network. Checksummed values with the wrong header, payload length, padding, HRP, or network are
  rejected as `400 BAD_REQUEST` before any chain-provider lookup. Mainnet addresses are separated
  from testnet addresses; preprod and preview both use network id `0`, so reward-address bytes do
  not distinguish those deployments. Use `/v1/status` to identify whether a deployment is preprod
  or preview.
- Transaction-status lookups canonicalize accepted hex hashes before querying upstream, so
  uppercase and mixed-case requests have the same seen/unseen result as lowercase requests.
- Transaction output references with leading-zero indices now resolve through their canonical
  decimal index instead of being reported as missing.

### Security

- The container image is patched. It was shipping **seven fixable HIGH/CRITICAL advisories**, two
  of them CRITICAL (libgnutls30), none of which any existing gate could see: `npm audit` only ever
  inspects our own dependency tree, and most of what ships is the base image.
- `npm` and `corepack` are removed from the runtime image. Nothing at runtime invokes them (the
  container runs `node dist/index.js`), and the npm bundled inside the Node image vendors its own
  dependency tree, which carried two more HIGH advisories we could neither patch nor pin because
  they were not our dependencies. Deleting the package manager from a production image is right
  regardless of the CVEs: a smaller image, and one fewer thing that can execute code from a
  lockfile.
- Transaction lifecycle responses expose only canonical status fields and sanitized terminal
  codes, never raw provider bodies or transaction material.
- **Stake keys and client IPs are no longer written to the request log.** Fastify's default log
  records the request URL and the caller's IP on the same line, and the account routes carry the
  stake key _in the URL_, so every balance refresh was writing a durable link between a wallet
  identity and a network identity. The path is now scrubbed (`/v1/account/[redacted]/utxos`) and
  the IP is not logged at all. The endpoint is still logged, so traffic is still countable.
- The live E2E harness now refuses mainnet runs unless the operator supplies the exact
  separate opt-in `ALLOW_MAINNET_E2E=true`, preventing accidental key derivation and
  transaction submission against real funds.
- A wallet identifier carried in an upstream path no longer reaches the response body or the log.
  Koios documents `/account_txs` as GET with `_stake_address`, so an upstream failure on account
  history named the caller's stake key in its message, which the error handler returns as the 502
  body and the retry line logs at the default `LOG_LEVEL`. Stake keys, Shelley and Byron payment
  addresses and 32-byte hashes are redacted from both. Public register ids, such as a pool or DRep
  id, and the endpoint itself survive, so the failure is still diagnosable.
- Anonymous per-IP rate limiting now ignores caller-supplied forwarding headers unless the
  connection came from an explicitly configured trusted proxy IP or CIDR range.
- The Helm chart exposes that allowlist as `config.trustProxy`, so an ingress or LoadBalancer
  install can name its proxies instead of leaving every caller in one rate-limit bucket.
- `TRUST_PROXY` rejects any entry wider than a `/8` in either family, rejects any IPv6 range that
  contains the IPv4-mapped block, and reads an entry inside that block as the IPv4 range it means.
  Rejecting only `/0` let the same reach through in other spellings: `0.0.0.0/1,128.0.0.0/1` covers
  every IPv4 address between two ordinary-looking entries, and `::ffff:0.0.0.0/96`, `::/8` and
  `::/80` each cover it on their own, since every IPv4 caller reaches a dual-stack listener as
  `::ffff:a.b.c.d`.

### Note

- Two gaps remain where Blockfrost's API cannot match Koios: CIP-68 metadata is limited to what
  Blockfrost decodes server-side, and proposal vote tallies are omitted (Blockfrost exposes no
  vote-summary endpoint, only power-less individual votes). A DRep's `deposit` is reported as the
  current protocol parameter, since Blockfrost does not echo the per-DRep amount. Each is
  documented at its call site.
- On `POST /v1/tx/utxos` the spent state of a **collateral** output cannot come from the transaction
  read: Blockfrost documents `consumed_by_tx` as always null on a collateral output, spent or not.
  Those outputs are resolved against the controlling address's live UTxO set instead, newest page
  first, and only they pay for the extra read. When even that cannot settle it, the reference is
  omitted from the response rather than reported unspent, because a wallet acts on `spent: false` by
  offering the output as collateral, and the node then rejects the transaction it builds.
- `filterUsedPaymentCredentials` remains `501` on Blockfrost: it exposes no payment-credential index
  (no equivalent of Koios's `/credential_txs`), so the read cannot be served there. A base Shelley
  wallet can use `filterUsedAddresses` with its derived addresses instead.
- Blockfrost reward history omits treasury and reserve (MIR) rewards, which Blockfrost surfaces on a
  separate resource without an earned epoch; member, leader, and deposit-refund rewards are covered.
- A transaction's `certificates` list is partial under Blockfrost: stake (de)registration, stake
  delegation, MIR, and pool registration/retirement certificates are reported, but Conway governance
  certificates (vote delegation, DRep registration/update/deregistration, committee auth/resign) are
  not, because `tx_content` carries no count for them and this API version has no per-transaction
  resource that lists them. The Koios provider reports these; parity here is a follow-up.
- Neither cache is served stale on the numbers. Membership is held briefly past expiry on a failed
  refresh (a stale _list_ beats a 502), but a DRep's voting power and a token's supply are always
  fresh, for the same reason account reads are never cached at all.
- Stale-on-error is off by default and is **never** set on an account-scoped read. A stale balance
  or UTxO set handed to a wallet that is about to build a transaction produces a failed submission
  or a double-spend, and "upstream was down" is not a licence to guess at someone's money.
- Account-scoped reads are never cached: account state, UTxOs, transaction history, and
  transaction status all go to upstream on every request. Serving a stale balance or a stale
  UTxO set to a wallet that is about to build a transaction produces a failed submission or a
  double-spend. The full cache policy is one list in `src/providers/cached.ts`, and anything
  absent from it is not cached.
- Protocol parameters are keyed on the epoch number rather than on a duration, so the cached
  value expires exactly when the thing it describes does, instead of at an arbitrary moment that
  may or may not be the epoch boundary.
- A transaction submit is never retried. `POST /v1/tx/submit` has no retry path at all: a
  transaction that actually landed, resent because the response to the first attempt was
  garbled, is a double-spend. Only reads are retried, and a 4xx (including a 429) is never
  retried, because a request upstream has already rejected will be rejected again.

## [0.7.1] - 2026-07-09

Modernizes the backend build and CI toolchain checks.

### Changed

- Documented the Node/npm toolchain pins and the upgrade checklist for runtime,
  framework, compiler, linter, and test-runner major bumps.
- Extended the baseline CI and local `check:ci` script to cover lint, format,
  typecheck, build, unit/API contract coverage, production dependency audit, and Docker
  build checks for regular and Dependabot PRs.
- Synced package-lock metadata with the current package version.

## [0.7.0] - 2026-07-08

Closes the account-rewards parity gap with the closed backend.

### Added

- `GET /v1/account/{stake}/state` now also returns `rewardsSum` (lifetime rewards ever
  earned) and `withdrawalsSum` (lifetime rewards ever withdrawn), alongside the existing
  `rewardsAvailable` (withdrawable now). Together these cover what the wallet's account
  state needs from the closed backend's per-reward-address totals
  (`spendable`/`nonSpendable`/`withdrawals`): the identity
  `rewardsSum - withdrawalsSum == rewardsAvailable` holds, and is checked live on preprod.
  Sourced from Koios `account_info`.

### Note

- A per-epoch reward history endpoint was considered and deliberately not built: the
  wallet consumes only aggregate reward totals (one figure per reward address), so a
  per-epoch list would be new surface beyond parity rather than parity.

## [0.6.0] - 2026-07-08

Toward parity with the pool data the existing wallet reads from the closed backend.

### Added

- `POST /v1/pools/info`: given `{ poolIds: [...] }` (bech32 `pool1...`), returns normalized
  stake-pool info in input order: registration status and retiring epoch, margin, fixed
  cost, declared and live pledge, active and live stake, saturation (as a fraction of the
  cap), live delegator count, lifetime blocks minted, and off-chain metadata (name,
  ticker, homepage, description). Built from Koios `pool_info`. Malformed input is
  rejected with `400` before any upstream call, and unknown pool ids are omitted.
- Live preprod integration coverage for pool info against a currently-registered pool.
- The e2e slice reads pool info back through `/v1/pools/info` for a live registered pool
  and checks the normalized shape, exercising the endpoint on the read path.

### Note

- Estimated ROA is intentionally not included yet: it is a derived analytic (the closed
  backend sources it from cexplorer), not raw chain data. It will be computed from pool
  reward history in a later change.

## [0.5.0] - 2026-07-08

### Added

- `POST /v1/addresses/filter-used`: given a batch of addresses, returns the subset that
  have appeared on chain (been used), in input order, for receive-address discovery.
  Built from Koios `address_info`. Malformed input is rejected with `400` before any
  upstream call: each address must be a bech32 payment address (`addr` / `addr_test`).
- The e2e slice now checks filter-used after its self-payment confirms, asserting the
  payment address reads back as used and a fresh derived address as unused, and pages
  history from the pre-submit tip so the assertion holds regardless of account age.

## [0.4.0] - 2026-07-08

Toward parity with the data the existing wallet reads from the closed backend.

### Added

- `GET /v1/account/{stake}/txs` for transaction history: inputs, outputs (with native
  assets), fee, withdrawals, certificates, metadata, and block info, oldest first, with
  `?after={block}` to page forward. Built from Koios `account_txs` + `tx_info`.
- The e2e slice now reads history after its self-payment confirms and asserts the
  transaction shows up, exercising the new endpoint against the live network.

## [0.3.0] - 2026-07-08

### Added

- `e2e/`: a self-contained end-to-end vertical slice that drives the `/v1` surface on a
  real network using the same CSL the Yoroi extension pins. It derives an address, reads
  balance and UTxOs, and builds, signs, submits, and confirms a self-payment. Kept
  minimal (plain ADA, one account) and separate from the backend's own tooling and CI.
- `.github/dependabot.yml`: npm and GitHub Actions updates with a 7-14 day cooldown to
  avoid installing brand-new (potentially compromised) releases, and dev-dependency
  grouping so overlapping bumps don't open conflicting PRs.

## [0.2.0] - 2026-07-08

Completes the barebones Koios read/write surface for a wallet.

### Added

- `GET /v1/account/{stake}/state` for balance, rewards, and current pool/DRep
  delegation, keyed by stake address.
- `GET /v1/account/{stake}/utxos` for the account's UTxOs in one call, including native
  assets and inline datums.
- `POST /v1/tx/submit` to submit a signed (CBOR hex) transaction and return its hash.
- `GET /v1/tx/{hash}/status` for confirmation status.
- `BadRequestError` (400) and boundary validation of stake addresses, transaction
  hashes, and the submit body.

## [0.1.0] - 2026-07-08

Initial scaffold.

### Added

- TypeScript and Fastify service skeleton with a factory-built server for testability.
- Provider abstraction (`ChainProvider`) so chain data is served independent of the
  underlying source.
- Koios provider implementing `getTip` and `getProtocolParams`, with an injectable
  fetch for deterministic tests.
- Normalized `/v1/chain/tip` and `/v1/chain/protocol-params` endpoints, a `/health`
  liveness check, and a stable error envelope.
- Config loading with validation and per-network Koios defaults.
- Unit tests across happy, unhappy, and regression paths, plus a preprod integration
  smoke test.
- CI gates that tighten from development through to main, a semver bump check, and a
  release job that tags from `package.json`.
- Contributor docs: a code style guide covering the conventions the tooling can't
  enforce, referenced from `CONTRIBUTING.md`.
