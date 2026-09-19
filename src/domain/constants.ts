/**
 * Protocol-derived constants shared across the boundary and the providers.
 *
 * These are fixed by the Cardano ledger, not by any one provider. They live here so that
 * request validation and provider-side parsing cannot drift apart: if the two disagreed on
 * how long a policy id is, a subject would validate at the boundary and then be split in
 * the wrong place upstream.
 */

/** A policy id is a Blake2b-224 script hash: 28 bytes, so 56 hex characters. */
export const POLICY_ID_HEX_LEN = 56

/** An asset name is at most 32 bytes, so 64 hex characters. */
export const MAX_ASSET_NAME_HEX_LEN = 64

/** A CIP-26 subject is a policy id followed by an optional asset name. */
export const MAX_SUBJECT_HEX_LEN = POLICY_ID_HEX_LEN + MAX_ASSET_NAME_HEX_LEN
