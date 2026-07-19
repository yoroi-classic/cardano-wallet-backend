### Added

- Publish versioned `cardano-wallet-backend` Helm charts as OCI artifacts in GHCR when chart
  changes reach `main`.
- Cancel superseded Helm validation for pull requests and non-main branches without dropping
  validation or queued publication within GitHub Actions' 100-run concurrency-group limit.
