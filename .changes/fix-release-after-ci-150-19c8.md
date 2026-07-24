### Fixed

- GitHub releases now wait for successful CI and tag only the exact successful commit while it
  remains the current `main` head. If `main` moves during publication, rollback retries and
  reconciles release deletion before removing a tag, and fails closed when GitHub cannot confirm
  the release is absent.
