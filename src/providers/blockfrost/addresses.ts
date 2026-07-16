import { z } from 'zod'
import type { AddressCapability } from '../capabilities/addresses.js'
import type { BlockfrostClient } from './client.js'

// A minimal projection of `address_content` (Blockfrost OpenAPI spec, `/addresses/{address}`).
// We only need to know whether the address exists at all, so this is a light shape check
// rather than the full schema — the same minimal-validation approach the Koios driver takes
// for its own `address_info` row.
const addressRow = z.object({ address: z.string() })

export function createAddressMethods(client: BlockfrostClient): AddressCapability {
  return {
    async filterUsedAddresses(addresses: string[]): Promise<string[]> {
      if (addresses.length === 0) return []

      // Blockfrost has no batch form of this question, unlike Koios's single `/address_info`
      // POST: "used" is 200 vs 404 on a per-address resource. Run the checks concurrently rather
      // than one at a time, and keep each result at its input index so a straight filter below
      // preserves the caller's order, exactly as Koios's version promises.
      const checks = await Promise.all(
        addresses.map(async (address) => {
          const row = await client.getOrUndefined(
            addressRow,
            `/addresses/${encodeURIComponent(address)}`,
          )
          return row !== undefined
        }),
      )
      return addresses.filter((_address, i) => checks[i] === true)
    },
  }
}
