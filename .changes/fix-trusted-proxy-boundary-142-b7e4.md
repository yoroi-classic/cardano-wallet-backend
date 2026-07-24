### Security

- Anonymous per-IP rate limiting now ignores caller-supplied forwarding headers unless the
  connection came from an explicitly configured trusted proxy IP or CIDR range.
