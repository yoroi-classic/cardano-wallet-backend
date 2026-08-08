### Security

- Anonymous per-IP rate limiting now ignores caller-supplied forwarding headers unless the
  connection came from an explicitly configured trusted proxy IP or CIDR range.
- The Helm chart exposes that allowlist as `config.trustProxy`, so an ingress or LoadBalancer
  install can name its proxies instead of leaving every caller in one rate-limit bucket.
