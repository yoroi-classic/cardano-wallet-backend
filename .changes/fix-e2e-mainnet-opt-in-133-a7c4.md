### Security

- The live E2E harness now refuses mainnet runs unless the operator supplies the exact
  separate opt-in `ALLOW_MAINNET_E2E=true`, preventing accidental key derivation and
  transaction submission against real funds.
