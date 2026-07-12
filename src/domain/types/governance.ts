/** Governance domain shapes: delegate representatives (DReps). */

/**
 * Registration lifecycle of a DRep. Normalized like `PoolStatus`, so the contract does not
 * hand clients a provider's own vocabulary.
 */
export type DrepStatus = 'registered' | 'deregistered' | 'not_registered'

/**
 * Normalized info for a delegate representative (DRep). Off-chain metadata (CIP-119) is
 * resolved best-effort into `name`/`image`; `metadataUrl`/`metadataHash` still point at the
 * raw source. Lovelace values are strings.
 */
export interface DrepInfo {
  /**
   * Bech32 DRep id, always in the CIP-129 form (`drep1...`, a 1-byte header plus the
   * credential), which is the current standard. The deprecated CIP-105 form is still
   * accepted on requests, but it is not what gets emitted here.
   */
  drepId: string
  /** The DRep's 28-byte credential, as hex. Identical across both id encodings. */
  hex: string
  /** Whether the DRep credential is a script. */
  hasScript: boolean
  /** Registration lifecycle. */
  status: DrepStatus
  /** Whether the DRep is currently active (not expired). */
  active: boolean
  /** Registration deposit, in lovelace. */
  deposit: string
  /** Voting power: total lovelace delegated to this DRep. */
  votingPower: string
  /** Epoch the DRep's registration expires in, if set. */
  expiresEpoch?: number
  /** URL of the DRep's off-chain (CIP-119) metadata, if any. */
  metadataUrl?: string
  /** Hash of the DRep's off-chain metadata, if any. */
  metadataHash?: string
  /** Display name from off-chain metadata (CIP-119 givenName), resolved best-effort. */
  name?: string
  /** Image pointer (URL/URI) from off-chain metadata. Not image bytes. */
  image?: string
}

/** Query for a page of the DRep list. */
export interface DrepListParams {
  /** Maximum DReps to return. */
  limit: number
  /** How many DReps to skip, for paging. */
  offset: number
}
