### Fixed

- GeckoTerminal request pacing now caps the number of queued calls released after an event-loop
  stall, preventing delayed timers from exceeding the configured upstream burst limit.
