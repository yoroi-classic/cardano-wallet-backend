/** Native-token (asset) domain shapes. */

/**
 * Where a token's display metadata was resolved from, in preference order.
 *
 * The type is derived from the array so the two cannot drift: anything that needs the set
 * at runtime (a test asserting a live asset resolved from a known source, for instance)
 * reads this rather than restating the members.
 */
export const TOKEN_SOURCES = ['registry', 'cip25', 'cip68', 'none'] as const

export type TokenMetadataSource = (typeof TOKEN_SOURCES)[number]

/**
 * Normalized metadata for a native token. On-chain basics (fingerprint, supply, names)
 * always apply. Display fields (name, ticker, description, decimals, url, image) are
 * resolved with the CIP-26 off-chain token registry preferred, then CIP-25 on-chain mint
 * metadata (the usual NFT case), then a CIP-68 reference-token datum; `source` says which
 * supplied them.
 *
 * Editorial curation the closed backend layered on top (scam/verified status, an
 * "application" category, a display symbol) is not chain data and is intentionally not
 * produced here. `image` is a pointer (e.g. an ipfs:// or https URL), not image bytes: the
 * bytes are served from a separate media surface, and the registry's base64 logo is not
 * inlined.
 */
export interface TokenMetadata {
  /** CIP-26 subject: policy id concatenated with the hex asset name. */
  subject: string
  /** Policy id (hex). */
  policyId: string
  /** Asset name (hex). */
  assetName: string
  /** Asset name decoded as ASCII, when it is printable. */
  assetNameAscii?: string
  /** CIP-14 asset fingerprint (asset1...). */
  fingerprint: string
  /** Total supply across all mints/burns, as a string. */
  supply: string
  /** Which metadata source supplied the display fields below. */
  source: TokenMetadataSource
  /** Human-readable name. */
  name?: string
  /** Ticker (registry or CIP-68). */
  ticker?: string
  /** Description. */
  description?: string
  /** Decimal places (registry or CIP-68). */
  decimals?: number
  /** Project URL (registry or CIP-68). */
  url?: string
  /** Image pointer (URL/URI), from CIP-25 or CIP-68 metadata. Not image bytes. */
  image?: string
}
