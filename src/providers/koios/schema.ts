import { z } from 'zod'
import type { Asset } from '../../domain/types/common.js'

/**
 * Koios returns lovelace-scale values as either numbers or numeric strings. Both
 * branches are constrained to non-negative integers so a malformed upstream value
 * (a negative, a float, a non-numeric string) fails validation and lands on the
 * MalformedUpstreamError path rather than propagating as junk.
 */
export const numeric = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])

/** A native asset as Koios spells it, on a UTxO or on a transaction input/output. */
export const assetItem = z.object({
  policy_id: z.string(),
  asset_name: z.string(),
  quantity: numeric,
})

/** Map Koios's asset rows onto the domain shape. Absent means no native assets. */
export function mapAssets(rows: z.infer<typeof assetItem>[] | null | undefined): Asset[] {
  return (rows ?? []).map((a) => ({
    policyId: a.policy_id,
    assetName: a.asset_name,
    quantity: String(a.quantity),
  }))
}
