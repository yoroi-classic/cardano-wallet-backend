### Fixed

- Invalid Koios retry, timeout, backoff, and request-body limits are rejected when the provider is
  constructed. Safe integer and timer-range bounds prevent malformed values from turning bounded
  retries into an effectively endless request or disabling request-size protection.
