import { z } from 'zod'
import { POLICY_ID_HEX_LEN } from '../../domain/constants.js'
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

const amountItem = z.object({ unit: z.string(), quantity: numeric })

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

  for (const item of items) {
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
