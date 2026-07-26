### Fixed

- Invalid Koios read-attempt budgets are rejected when the provider is constructed, preventing
  non-finite or unsafe values from turning bounded retries into an effectively endless request.
