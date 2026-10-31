import { z } from 'zod'
import type { AddressCapability } from '../capabilities/addresses.js'
import type { KoiosClient } from './client.js'
import { numeric, assetItem, mapAssets } from './schema.js'
import type { Utxo } from '../../domain/types/transactions.js'

const addressRow = z.object({ address: z.string() })
// Koios defaults list endpoints to 1,000 rows. Script addresses can hold more than that,
// so explicitly page until the final short page instead of silently omitting UTxOs.
const ADDRESS_UTXO_PAGE_SIZE = 1000
const addressUtxoRow = z.object({
  tx_hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  tx_index: z.number().int().nonnegative(),
  address: z.string(),
  value: numeric,
  asset_list: z.array(assetItem).nullish(),
  datum_hash: z.string().nullish(),
  inline_datum: z.object({ bytes: z.string() }).nullish(),
  reference_script: z
    .object({
      hash: z.string().regex(/^[0-9a-fA-F]{56}$/),
      size: z.number().int().nonnegative().optional(),
      type: z.string().optional(),
      bytes: z
        .string()
        .regex(/^([0-9a-fA-F]{2})+$/)
        .optional(),
    })
    .nullish(),
})

const mapAddressUtxo = (row: z.infer<typeof addressUtxoRow>): Utxo => ({
  txHash: row.tx_hash,
  outputIndex: row.tx_index,
  address: row.address,
  value: String(row.value),
  assets: mapAssets(row.asset_list),
  datumHash: row.datum_hash ?? undefined,
  inlineDatum: row.inline_datum?.bytes ?? undefined,
  referenceScriptHash: row.reference_script?.hash ?? undefined,
  referenceScript: row.reference_script ?? undefined,
})

export function createAddressMethods(koios: KoiosClient): AddressCapability {
  return {
    async getAddressUtxos(address: string): Promise<Utxo[]> {
      const outputs: Utxo[] = []
      for (let offset = 0; ; offset += ADDRESS_UTXO_PAGE_SIZE) {
        const query = new URLSearchParams({
          limit: String(ADDRESS_UTXO_PAGE_SIZE),
          offset: String(offset),
        })
        const rows = await koios.batch(z.array(addressUtxoRow), `/address_utxos?${query}`, {
          _addresses: [address],
          _extended: true,
        })
        outputs.push(...rows.map(mapAddressUtxo))
        if (rows.length < ADDRESS_UTXO_PAGE_SIZE) return outputs
      }
    },

    async filterUsedAddresses(addresses: string[]): Promise<string[]> {
      if (addresses.length === 0) return []
      // Koios address_info returns a row only for addresses seen on chain, so the ones
      // that come back are the used set. Preserve the caller's order.
      const rows = await koios.batch(z.array(addressRow), '/address_info', {
        _addresses: addresses,
      })
      const used = new Set(rows.map((r) => r.address))
      return addresses.filter((a) => used.has(a))
    },
  }
}
