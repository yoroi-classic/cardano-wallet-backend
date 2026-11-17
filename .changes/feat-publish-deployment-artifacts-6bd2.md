### Added

- Support explicit single-hop proxy trust for backends restricted to a source-preserving ingress, retaining per-client rate limits without trusting earlier forwarded addresses.

- Publish tested backend image revisions for AMD64 and ARM64 to GHCR, and publish the Helm chart from development and main for cluster deployment.

### Fixed

- Reuse an existing chart version during branch promotion only when the packaged chart contents are identical.
