import { z } from 'zod'
import type { Utxo, WalletTransaction } from '../../domain/types/transactions.js'
import type { AddressCapability } from '../capabilities/addresses.js'
import type { KoiosClient } from './client.js'
import { assetItem, mapAssets, numeric } from './schema.js'
import { hydrateTxHistory } from './tx-info.js'

// How many transactions we detail per page. Matches the stake-account history page (and the
// extension's request size).
const HISTORY_PAGE_SIZE = 50
// A large credential OR-query can time out on Koios when one member is used. Probe small groups
// concurrently, then recursively split only the groups that matched. Follow-up #107 replaces
// this workaround when an upstream bulk result identifies the matching credential directly.
const CREDENTIAL_PROBE_SIZE = 5

const addressRow = z.object({ address: z.string() })

// Address-keyed sibling of koios/account.ts's accountUtxoRow. Kept as its own copy rather than
// shared: the two schemas answer different Koios RPCs (/address_utxos vs /account_utxos) that
// happen to overlap in shape today, and koios/tx.ts's utxoRow shows this project's own precedent
// for that (it duplicates the same shape again, for /utxo_info).
const addressUtxoRow = z.object({
  tx_hash: z.string(),
  tx_index: z.number(),
  address: z.string(),
  value: numeric,
  asset_list: z.array(assetItem).nullish(),
  datum_hash: z.string().nullish(),
  inline_datum: z.object({ bytes: z.string() }).nullish(),
  reference_script: z.object({ hash: z.string() }).nullish(),
})

function mapAddressUtxo(row: z.infer<typeof addressUtxoRow>): Utxo {
  return {
    txHash: row.tx_hash,
    outputIndex: row.tx_index,
    address: row.address,
    value: String(row.value),
    assets: mapAssets(row.asset_list),
    datumHash: row.datum_hash ?? undefined,
    inlineDatum: row.inline_datum?.bytes ?? undefined,
    referenceScriptHash: row.reference_script?.hash ?? undefined,
  }
}

// /address_txs is exactly as thin as /account_txs (verified against the Koios OpenAPI spec):
// tx_hash, block_height, block_time, epoch_no and nothing else, so the same list-then-hydrate
// pattern through /tx_info applies.
const addressTxRow = z.object({
  tx_hash: z.string(),
  block_height: z.number(),
  block_time: z.number(),
  epoch_no: z.number(),
})

/**
 * Body-size chunking composed with Content-Range paging. Two independent Koios limits bite on an
 * address-set read: a request body over the byte budget is rejected (so a large set is packed
 * into several bodies), and a single response is capped at 1,000 rows (so each body must then be
 * walked page by page). The client's batchAll only ever split request bodies; it never followed
 * the response range, so a wallet with more than 1,000 matching rows silently lost the overflow.
 *
 * The packing runs through koios.packAdaptively, the same body-budget primitive batchAll uses, so
 * these reads inherit its 413 handling: a self-hosted or proxied Koios that advertises a smaller
 * body cap lowers the client's limit, the address set is repacked, and the run is retried, instead
 * of surfacing a 502. Each chunk is then read through koios.batchAllPages, the shared paged-read
 * primitive the account-utxos pagination work also adds to the client; once that lands on
 * development the two client-side definitions collapse to one and this keeps calling it unchanged.
 *
 * The whole set is fetched, not just the page a caller ultimately needs, because Koios pages a
 * single body and cannot merge address chunks itself. batchAllPages' own upper bound guards the
 * pathological case; in practice a caller narrows the set with `after` before it ever grows large.
 */
function pagedBatchAll<Row>(
  koios: KoiosClient,
  rowSchema: z.ZodType<Row>,
  path: string,
  addresses: string[],
  toBody: (chunk: string[]) => unknown,
  rowKey?: (row: Row) => string,
): Promise<Row[]> {
  return koios.packAdaptively(addresses, toBody, (body) =>
    koios.batchAllPages(rowSchema, path, body, rowKey),
  )
}

export function createAddressMethods(koios: KoiosClient): AddressCapability {
  async function usedPaymentCredentials(credentials: string[]): Promise<string[]> {
    if (credentials.length === 0) return []

    // Koios accepts a credential batch, but /credential_txs does not identify which member
    // matched. An empty response proves the whole group unused; a non-empty response is split
    // until the matching singleton(s) are known. `limit=1` keeps every existence probe small.
    const rows = await koios.batch(z.array(addressTxRow), '/credential_txs?limit=1', {
      _payment_credentials: credentials,
    })
    if (rows.length === 0) return []
    if (credentials.length === 1) return credentials

    const middle = Math.ceil(credentials.length / 2)
    const left = await usedPaymentCredentials(credentials.slice(0, middle))
    const right = await usedPaymentCredentials(credentials.slice(middle))
    return [...left, ...right]
  }

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

    async filterUsedPaymentCredentials(paymentCredentials: string[]): Promise<string[]> {
      const unique = [...new Set(paymentCredentials)]
      if (unique.length === 0) return []
      const groups: string[][] = []
      for (let start = 0; start < unique.length; start += CREDENTIAL_PROBE_SIZE) {
        groups.push(unique.slice(start, start + CREDENTIAL_PROBE_SIZE))
      }
      const used = new Set((await Promise.all(groups.map(usedPaymentCredentials))).flat())
      return unique.filter((credential) => used.has(credential))
    },

    async getUtxosByAddresses(addresses: string[]): Promise<Utxo[]> {
      if (addresses.length === 0) return []
      // Stable order so the pages tile a single result set, and an output reference
      // (tx_hash#tx_index) as the key so a UTxO cannot be double-counted across a page boundary.
      const rows = await pagedBatchAll(
        koios,
        addressUtxoRow,
        '/address_utxos?order=tx_hash.asc,tx_index.asc',
        addresses,
        (chunk) => ({ _addresses: chunk, _extended: true }),
        (row) => `${row.tx_hash}#${row.tx_index}`,
      )
      return rows.map(mapAddressUtxo)
    },

    async getTxHistoryByAddresses(
      addresses: string[],
      afterBlock?: number,
    ): Promise<WalletTransaction[]> {
      if (addresses.length === 0) return []

      // Oldest first, ordered on a key unique per transaction (block_height then tx_hash) so the
      // pages tile without skipping history. No row key is enforced across pages here: a single
      // transaction legitimately comes back once per matching address (a self-transfer), and those
      // repeats are collapsed by tx_hash just below rather than treated as an upstream duplicate.
      const rows = await pagedBatchAll(
        koios,
        addressTxRow,
        '/address_txs?order=block_height.asc,tx_hash.asc',
        addresses,
        (chunk) => ({
          _addresses: chunk,
          ...(afterBlock === undefined ? {} : { _after_block_height: afterBlock }),
        }),
      )
      if (rows.length === 0) return []

      // A transaction touching more than one of the requested addresses (a self-transfer within
      // the same wallet, most commonly) comes back once per matching address, since Koios
      // answers per address and the set is batched independently. Collapse to one row per
      // tx_hash before paging, or the same transaction would occupy more than one slot in the
      // page and /tx_info would see it requested twice.
      const byHash = new Map<string, z.infer<typeof addressTxRow>>()
      for (const row of rows) byHash.set(row.tx_hash, row)
      const distinct = [...byHash.values()]

      // One page, oldest first. Don't cut through a block: include any trailing txs that share
      // the boundary block, so the next `after={block}` cursor can't skip the rest of it.
      const sorted = distinct.sort((a, b) => a.block_height - b.block_height)
      let end = Math.min(HISTORY_PAGE_SIZE, sorted.length)
      const boundaryBlock = sorted[end - 1]?.block_height
      while (end < sorted.length && sorted[end]?.block_height === boundaryBlock) end += 1
      const hashes = sorted.slice(0, end).map((r) => r.tx_hash)

      return hydrateTxHistory(koios, hashes)
    },
  }
}
