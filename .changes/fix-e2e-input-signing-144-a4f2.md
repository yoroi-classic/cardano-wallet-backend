### Fixed

- E2E self-payments restrict coin selection to ADA outputs at the address whose payment key the
  harness derives, so account-wide UTxOs cannot introduce an input the harness cannot sign.
