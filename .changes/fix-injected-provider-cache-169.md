### Fixed

- Factory-created chain providers now honor the process cache injected by the application instead
  of allocating a second store. Provider entries are scoped by driver and network, while
  standalone construction keeps its configured private-cache or no-cache fallback.
- Clearing a provider namespace also invalidates in-flight batch metadata writes, so a response
  that started before the clear cannot repopulate the namespace afterward.
