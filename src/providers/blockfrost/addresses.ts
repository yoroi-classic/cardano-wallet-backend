import { z } from 'zod'
import type { Utxo, WalletTransaction } from '../../domain/types/transactions.js'
import type { AddressCapability } from '../capabilities/addresses.js'
import { ProviderError } from '../../domain/errors.js'
import type { BlockfrostClient } from './client.js'
import { mapWithConcurrency } from './concurrency.js'
import { notImplemented } from './not-implemented.js'
import { amountList, splitAmount } from './schema.js'
import { addressSetTxHistory } from './tx-info.js'

// How many address lookups this driver keeps in flight at once. Blockfrost answers "used" as a
// per-address 200/404, so a wallet restore turns into one request per address; a modest ceiling
// overlaps the round trips without opening hundreds of authenticated connections at once and
// tripping the rate limiter for the whole batch.
const ADDRESS_LOOKUP_CONCURRENCY = 10

// The same modest fan-out for the per-address utxo reads. Each is itself a paged walk, so the
// requests are already spread over time; the ceiling keeps a large address set from opening one
// connection per address at once.
const ADDRESS_UTXO_CONCURRENCY = 10

// Blockfrost's own documented maximum per utxo page, and a defensive page bound matching the
// account-utxo scan: 5,000 utxos on a single address is a runaway, not a wallet.
const UTXO_PAGE_SIZE = 100
const UTXO_MAX_PAGES = 50

// A minimal projection of `address_content` (Blockfrost OpenAPI spec, `/addresses/{address}`).
// We only need to know whether the address exists at all, so this is a light shape check
// rather than the full schema — the same minimal-validation approach the Koios driver takes
// for its own `address_info` row.
const addressRow = z.object({ address: z.string() })

// One row of `address_utxo_content` (Blockfrost OpenAPI spec, `/addresses/{address}/utxos`). The
// `address` is carried on the row, but a query is scoped to a single address anyway, so it is read
// leniently and the queried address stands in if a row ever omits it. `tx_index` is documented
// deprecated in favour of `output_index`, so it is not read.
const addressUtxoRow = z.object({
  address: z.string().nullish(),
  tx_hash: z.string(),
  output_index: z.number().int().nonnegative(),
  amount: amountList,
  data_hash: z.string().nullish(),
  inline_datum: z.string().nullish(),
  reference_script_hash: z.string().nullish(),
})

function mapUtxo(row: z.infer<typeof addressUtxoRow>, queriedAddress: string): Utxo {
  const { value, assets } = splitAmount(row.amount)
  return {
    txHash: row.tx_hash,
    outputIndex: row.output_index,
    address: row.address ?? queriedAddress,
    value,
    assets,
    datumHash: row.data_hash ?? undefined,
    inlineDatum: row.inline_datum ?? undefined,
    referenceScriptHash: row.reference_script_hash ?? undefined,
  }
}

/**
 * Every UTxO controlled by one address, walked page by page. A never-used address answers 404,
 * meaning it controls nothing rather than being an error. A full final page triggers the same
 * boundary probe the account-utxo scan uses, so an address ending exactly on a page boundary is
 * told apart from one genuinely past the scan bound.
 */
async function fetchAddressUtxos(client: BlockfrostClient, address: string): Promise<Utxo[]> {
  const path = `/addresses/${encodeURIComponent(address)}/utxos`
  const rows: z.infer<typeof addressUtxoRow>[] = []

  for (let page = 1; page <= UTXO_MAX_PAGES; page += 1) {
    const pageRows = await client.getOrUndefined(
      z.array(addressUtxoRow),
      `${path}?count=${UTXO_PAGE_SIZE}&page=${page}`,
    )
    if (pageRows === undefined) return []
    rows.push(...pageRows)
    if (pageRows.length < UTXO_PAGE_SIZE) return rows.map((row) => mapUtxo(row, address))
  }

  const probe = await client.getOrUndefined(
    z.array(addressUtxoRow),
    `${path}?count=${UTXO_PAGE_SIZE}&page=${UTXO_MAX_PAGES + 1}`,
  )
  if (probe === undefined || probe.length === 0) return rows.map((row) => mapUtxo(row, address))
  throw new ProviderError(
    `blockfrost address utxos exceed this provider's ${UTXO_MAX_PAGES * UTXO_PAGE_SIZE}-utxo scan bound`,
  )
}

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

    // async so notImplemented()'s synchronous throw becomes a rejected promise rather than escaping
    // the call before a caller's `await` sees it. See the note in assets.ts.
    async filterUsedPaymentCredentials(_paymentCredentials: string[]): Promise<string[]> {
      // Blockfrost exposes no payment-credential index. Every address resource is keyed by a full
      // bech32 address, and there is no equivalent of Koios's `/credential_txs` or `/credential_utxos`
      // that would answer usage for a bare payment credential, nor any way to enumerate the addresses
      // that share one. So there is no honest implementation of this read on Blockfrost, and faking it
      // (deriving addresses, or scanning) would be guesswork; it stays a 501. A base Shelley wallet can
      // use `filterUsedAddresses` with its derived addresses instead. See issue #111.
      return notImplemented(
        'filterUsedPaymentCredentials',
        'blockfrost exposes no payment-credential index; there is no endpoint that resolves usage ' +
          'by payment credential the way koios /credential_txs does, so this read cannot be served ' +
          'on blockfrost — use filterUsedAddresses with derived addresses instead (see issue #111)',
      )
    },

    async getUtxosByAddresses(addresses: string[]): Promise<Utxo[]> {
      if (addresses.length === 0) return []
      // Blockfrost has no batch utxo endpoint, so read each address's utxos under a bounded fan-out
      // and merge them in the caller's address order, preserving Koios's merged-set semantics.
      const perAddress = await mapWithConcurrency(addresses, ADDRESS_UTXO_CONCURRENCY, (address) =>
        fetchAddressUtxos(client, address),
      )
      return perAddress.flat()
    },

    async getTxHistoryByAddresses(
      addresses: string[],
      afterBlock?: number,
    ): Promise<WalletTransaction[]> {
      // Same shared walk the stake-account history uses once it has enumerated its addresses: read
      // each address's transactions, dedup a self-transfer by hash, page oldest-first on afterBlock,
      // and hydrate. Empty input short-circuits inside.
      return addressSetTxHistory(client, addresses, afterBlock)
    },
  }
}
