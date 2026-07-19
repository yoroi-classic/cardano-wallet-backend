import { z } from 'zod'
import type { Utxo, WalletTransaction } from '../../domain/types/transactions.js'
import type { AddressCapability } from '../capabilities/addresses.js'
import type { BlockfrostClient } from './client.js'
import { mapWithConcurrency } from './concurrency.js'
import { notImplemented } from './not-implemented.js'

// How many address lookups this driver keeps in flight at once. Blockfrost answers "used" as a
// per-address 200/404, so a wallet restore turns into one request per address; a modest ceiling
// overlaps the round trips without opening hundreds of authenticated connections at once and
// tripping the rate limiter for the whole batch.
const ADDRESS_LOOKUP_CONCURRENCY = 10

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
      // POST: "used" is 200 vs 404 on a per-address resource. Run the checks with a bounded pool
      // rather than one at a time or all at once, and keep each result at its input index so a
      // straight filter below preserves the caller's order, exactly as Koios's version promises.
      const checks = await mapWithConcurrency(
        addresses,
        ADDRESS_LOOKUP_CONCURRENCY,
        async (address) => {
          const row = await client.getOrUndefined(
            addressRow,
            `/addresses/${encodeURIComponent(address)}`,
          )
          return row !== undefined
        },
      )
      return addresses.filter((_address, i) => checks[i] === true)
    },

    // The three below are async so notImplemented()'s synchronous throw becomes a rejected
    // promise rather than escaping the call before a caller's `await` sees it. See the note in
    // assets.ts. These landed on the capability interface after this driver's first slice; they
    // are the address-set reads Koios serves and Blockfrost has not been wired for yet (see #4).
    async filterUsedPaymentCredentials(_paymentCredentials: string[]): Promise<string[]> {
      return notImplemented('filterUsedPaymentCredentials')
    },

    async getUtxosByAddresses(_addresses: string[]): Promise<Utxo[]> {
      return notImplemented('getUtxosByAddresses')
    },

    async getTxHistoryByAddresses(
      _addresses: string[],
      _afterBlock?: number,
    ): Promise<WalletTransaction[]> {
      return notImplemented('getTxHistoryByAddresses')
    },
  }
}
