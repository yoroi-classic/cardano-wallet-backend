/**
 * Domain shapes shared by more than one area. Keep this file small: a type earns its
 * place here only when two unrelated areas both need it. Anything used by a single area
 * belongs in that area's module instead.
 */

/** A native (non-ADA) asset held in a UTxO. */
export interface Asset {
  /** Policy id (hex). */
  policyId: string
  /** Asset name (hex). */
  assetName: string
  /** Quantity, as a string to avoid precision loss. */
  quantity: string
}
