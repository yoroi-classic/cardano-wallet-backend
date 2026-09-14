import { z } from 'zod'
import { ProviderError } from '../../domain/errors.js'
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

/**
 * The same value, permitting a negative.
 *
 * Reserved for the one field that genuinely goes below zero. Koios computes an account's
 * `total_balance` without its `proposal_refund` column, so an account with a governance deposit
 * outstanding reports a negative controlled balance until the deposit returns. That is upstream's
 * arithmetic and not a malformed value, and rejecting it took the whole account-state read down
 * with a 502 for every DRep and SPO who had ever submitted a governance action.
 *
 * Deliberately not the default. Every other lovelace field here is a quantity that cannot be
 * negative, and for those a minus sign really is malformed upstream data worth failing on. Both
 * branches keep the guarantees `numeric` documents above: a safe integer on the number branch,
 * every digit preserved on the string branch.
 */
export const signedNumeric = z.union([
  z.number().int().safe(),
  z.string().regex(/^-?(?:0|[1-9]\d*)$/),
])

/** A minting policy id is the 28-byte hash of the policy script: always 56 hex chars. */
export const policyId = z.string().regex(/^[0-9a-fA-F]{56}$/)

/**
 * An asset name is up to 32 bytes, hex-encoded as complete byte pairs. Empty is deliberate and
 * common: a policy's unnamed asset is a real, valid token, so this cannot demand at least one
 * byte the way the policy id does. Case is preserved because both upper- and lowercase hex encode
 * the same bytes and the domain contract permits either.
 */
export const assetName = z.string().regex(/^(?:[0-9a-fA-F]{2}){0,32}$/)

/** A native asset as Koios spells it, on a UTxO or on a transaction input/output. */
export const assetItem = z.object({
  policy_id: policyId,
  asset_name: assetName,
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

/**
 * Koios's documented request-body limit, in bytes. Not a guess: it is in the API overview, and
 * the 413 says it out loud as well ("Please ensure your request body size is below 5120 bytes").
 */
export const KOIOS_BODY_LIMIT_BYTES = 5120

/**
 * Held back from the limit so a chunk is never packed to the last byte.
 *
 * The arithmetic below is exact for the bodies we send, but it is exact only as long as nothing
 * in the pipeline adds a byte we did not count: a header rewritten by a proxy, an item that
 * serializes differently than we predicted, a limit that is really 5120 inclusive rather than
 * exclusive. A hundred bytes of headroom costs about 1.5 pool ids per request and removes a
 * whole class of off-by-one 413s.
 */
const BODY_SAFETY_MARGIN_BYTES = 128

/**
 * Pack items into chunks whose serialized request body stays inside `budget` bytes.
 *
 * Koios's real constraint is a **byte budget, not an item count**, and we used to chunk by
 * count: 50 pool ids, 50 DRep ids, 20 asset subjects, each number arrived at by bisecting
 * against a 413 until it stopped happening. That was wasteful in the ordinary case (86 pool ids
 * actually fit in the budget, so we were sending 1.7x more requests than we needed to) and it
 * was a latent bug in the interesting case: an `asset_info` subject is a 56-char policy id plus
 * an asset name of 0 to 64 hex chars, so it is *variable* length, and a fixed count of 20 was
 * safe only by luck. Nothing enforced that the 20 largest possible subjects still fit.
 *
 * Measuring instead of guessing fixes both, and it is not expensive. The serialized length of a
 * JSON array is exactly the envelope, plus each item's own serialized length, plus one comma
 * between each pair, so the whole pack is a single linear walk with no re-serialization.
 *
 * `toBody` builds the real request body from a chunk, so whatever else that body carries (the
 * `_extended: true` on account_utxos, the flags on tx_info) is measured too, rather than being
 * a surprise on the wire.
 */
export function packBySize<T>(items: T[], toBody: (chunk: T[]) => unknown, budget: number): T[][] {
  if (items.length === 0) return []

  const limit = budget - BODY_SAFETY_MARGIN_BYTES
  // The body with an empty item list: every key, brace, quote and the `[]` itself.
  const envelope = Buffer.byteLength(JSON.stringify(toBody([])))

  const chunks: T[][] = []
  let current: T[] = []
  let used = 0

  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item))

    // An item that cannot fit in a request *by itself* is a programming error, not a runtime
    // condition: no amount of chunking will make it send. Fail loudly rather than emit a chunk
    // we already know upstream will reject.
    if (envelope + itemBytes > limit) {
      throw new ProviderError(
        `koios request item is ${itemBytes} bytes, which cannot fit in a ${budget}-byte body`,
      )
    }

    const separator = current.length === 0 ? 0 : 1
    if (current.length > 0 && envelope + used + separator + itemBytes > limit) {
      chunks.push(current)
      current = [item]
      used = itemBytes
    } else {
      current.push(item)
      used += separator + itemBytes
    }
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}
