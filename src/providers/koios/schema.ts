import { z } from 'zod'
import type { Asset } from '../../domain/types/common.js'

/**
 * Koios returns lovelace-scale values as either numbers or numeric strings. Both branches
 * are constrained to non-negative integers so a malformed upstream value (a negative, a
 * float, a non-numeric string) fails validation and lands on the MalformedUpstreamError
 * path rather than propagating as junk.
 *
 * The number branch additionally demands a *safe* integer. A lovelace amount above 2^53
 * cannot survive `JSON.parse`: 7682048683977123456 is already 7682048683977124000 by the
 * time any schema sees it, and stringifying that yields a wrong-but-plausible balance. The
 * value is unrecoverable at this point, so the only honest move is to reject it. Koios
 * sends large amounts as strings, which take the string branch and keep every digit.
 */
export const numeric = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d+$/)])

/** Policy ids and asset names cross the wire as hex, and the domain types promise hex. */
const hex = z.string().regex(/^[0-9a-fA-F]*$/)

/** A native asset as Koios spells it, on a UTxO or on a transaction input/output. */
export const assetItem = z.object({
  policy_id: hex,
  asset_name: hex,
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

/** Split a list into fixed-size chunks. Koios 413s on an oversized request body. */
export function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}
