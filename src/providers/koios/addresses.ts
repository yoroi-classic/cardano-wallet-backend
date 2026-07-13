import { z } from 'zod'
import type { AddressCapability } from '../capabilities/addresses.js'
import type { KoiosClient } from './client.js'

const addressRow = z.object({ address: z.string() })

export function createAddressMethods(koios: KoiosClient): AddressCapability {
  return {
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
