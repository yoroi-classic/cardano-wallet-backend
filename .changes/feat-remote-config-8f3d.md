### Added

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
