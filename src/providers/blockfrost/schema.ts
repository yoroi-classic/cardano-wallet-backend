import { z } from 'zod'
import { MAX_ASSET_NAME_HEX_LEN, POLICY_ID_HEX_LEN } from '../../domain/constants.js'
import { MalformedUpstreamError } from '../../domain/errors.js'
import type { Asset } from '../../domain/types/common.js'

/**
 * Lovelace-scale values, exactly like the Koios client's own `numeric`: a number or a numeric
 * string, both bounded to a non-negative safe integer so a malformed upstream value can't
 * silently become the wrong money amount. Blockfrost's spec types these fields as strings, but
 * the union guards against the API sending a bare number without warning, the same defensive
 * stance the Koios driver takes.
 */
export const numeric = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d+$/)])

/**
 * A handful of protocol parameters — `max_val_size` is the one this driver reads — that
 * Blockfrost's spec types as a numeric string but our domain models as a plain `number`, because
 * they are small, protocol-bounded counts rather than money that can overflow a safe integer.
 */
export const smallNumeric = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
  .transform((v) => (typeof v === 'string' ? Number(v) : v))
  .pipe(z.number().int().nonnegative().safe())

/**
 * A well-formed `amount` unit is either the literal `lovelace` or a concatenated subject: a
 * 56-hex-char (28-byte) policy id followed by an optional asset name of at most 64 hex chars (32
 * bytes), and a hex asset name is always an even number of characters. Anything else — a short or
 * non-hex policy id, an odd-length or oversized asset name — is not a unit we can split into a
 * real {policyId, assetName}, so it is malformed upstream data rather than an Asset to expose.
 */
const UNIT_PATTERN = new RegExp(
  `^[0-9a-fA-F]{${POLICY_ID_HEX_LEN}}(?:[0-9a-fA-F]{2}){0,${MAX_ASSET_NAME_HEX_LEN / 2}}$`,
)

function isValidUnit(unit: string): boolean {
  return unit === 'lovelace' || UNIT_PATTERN.test(unit)
}

const amountItem = z.object({
  unit: z.string().refine(isValidUnit, { message: 'malformed asset unit' }),
  quantity: numeric,
})

/** Blockfrost's `amount` array, as it appears on a UTxO or a transaction's outputs. */
export const amountList = z.array(amountItem)

/**
 * Split Blockfrost's flat `amount` list into our normalized {value, assets} shape. Blockfrost
 * has no separate lovelace field the way Koios does: ADA is just the entry whose `unit` is the
 * literal string `"lovelace"`, and every other entry's `unit` is a policy id (28 bytes, 56 hex
 * chars) with the hex asset name concatenated directly after it, no separator.
 */
export function splitAmount(items: z.infer<typeof amountList>): { value: string; assets: Asset[] } {
  let value: string | undefined
  const assets: Asset[] = []
  // A real amount list names each unit at most once. A repeat — a second `lovelace`, or the same
  // native asset twice — would let one entry silently overwrite another (in particular a duplicate
  // `lovelace` would clobber the real ADA value), so treat any repeat as malformed rather than
  // guessing which entry is authoritative.
  const seen = new Set<string>()

  for (const item of items) {
    // Hex casing does not change a native asset's identity. Keep the upstream spelling for the
    // returned policy id and asset name, but use a canonical key so case variants cannot bypass
    // the duplicate guard.
    const unitKey = item.unit.toLowerCase()
    if (seen.has(unitKey)) {
      throw new MalformedUpstreamError(
        `blockfrost returned a utxo amount with a duplicate '${item.unit}' unit`,
      )
    }
    seen.add(unitKey)
    if (item.unit === 'lovelace') {
      value = String(item.quantity)
      continue
    }
    assets.push({
      policyId: item.unit.slice(0, POLICY_ID_HEX_LEN),
      assetName: item.unit.slice(POLICY_ID_HEX_LEN),
      quantity: String(item.quantity),
    })
  }

  // Every real Cardano UTxO carries a lovelace entry: the ledger's minimum-UTxO-value rule
  // enforces it, so there is no such thing as a genuine token-only output. An amount list
  // missing one is not a lovelace-free output, it is a malformed response.
  if (value === undefined) {
    throw new MalformedUpstreamError("blockfrost returned a utxo amount with no 'lovelace' unit")
  }
  return { value, assets }
}
