### Fixed

- E2E pool discovery now surfaces Koios HTTP failures before parsing the response, without
  copying upstream error bodies or configured URL credentials into its error message.
