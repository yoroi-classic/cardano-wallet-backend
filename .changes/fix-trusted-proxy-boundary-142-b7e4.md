### Security

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
