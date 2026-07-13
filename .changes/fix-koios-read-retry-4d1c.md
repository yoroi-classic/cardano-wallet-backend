### Fixed

- An upstream read that comes back off-spec is now retried before it is surfaced as an
  error. Some of the instances behind `api.koios.rest` intermittently answer with responses
  that do not match Koios's own API spec (a null `active` on `/drep_info`, a phantom
  `registered` column on a filtered `/drep_list`), which previously failed a fraction of
  `GET /v1/governance/dreps` requests through no fault of the caller. Reads get three
  attempts with a short linear backoff, and each retry is logged, so an unhealthy upstream
  is visible rather than silent.

### Note

- A transaction submit is never retried. `POST /v1/tx/submit` has no retry path at all: a
  transaction that actually landed, resent because the response to the first attempt was
  garbled, is a double-spend. Only reads are retried, and a 4xx (including a 429) is never
  retried, because a request upstream has already rejected will be rejected again.
