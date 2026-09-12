import { z } from 'zod'
import { MalformedUpstreamError } from '../../domain/errors.js'
import type { Utxo, WalletTransaction } from '../../domain/types/transactions.js'
import type { AddressCapability } from '../capabilities/addresses.js'
import type { KoiosClient } from './client.js'
import { assetItem, mapAssets, numeric } from './schema.js'
import { hydrateTxHistory } from './tx-info.js'

// How many transactions we detail per page. Matches the stake-account history page (and the
// extension's request size).
const HISTORY_PAGE_SIZE = 50
const HISTORY_MAX_LIST_ROWS = 100_000
// A large credential OR-query can time out on Koios when one member is used. Probe small groups
// concurrently, then recursively split only the groups that matched. Follow-up #107 replaces
// this workaround when an upstream bulk result identifies the matching credential directly.
const CREDENTIAL_PROBE_SIZE = 5
const CREDENTIAL_PROBE_CONCURRENCY = 4

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
type AddressTxRow = z.infer<typeof addressTxRow>

interface AddressHistoryStream {
  body: unknown
  rows: AddressTxRow[]
  index: number
  offset: number
  done: boolean
  last?: AddressTxRow
}

function compareAddressTxRows(left: AddressTxRow, right: AddressTxRow): number {
  if (left.block_height !== right.block_height) return left.block_height - right.block_height
  if (left.tx_hash === right.tx_hash) return 0
  return left.tx_hash < right.tx_hash ? -1 : 1
}

async function fillAddressHistoryStream(
  koios: KoiosClient,
  stream: AddressHistoryStream,
  path: string,
): Promise<void> {
  if (stream.done || stream.index < stream.rows.length) return

  // Match batchAllPages' 100,000-row safety bound. The count in Content-Range describes the whole
  // matching set, including rows beyond the bounded history page we return, so it is not itself a
  // reason to reject a valid prefix. Probe once after walking the bound to ensure an unusually
  // large boundary block cannot be silently truncated.
  const probingBound = stream.offset >= HISTORY_MAX_LIST_ROWS
  const limit = probingBound ? 1 : HISTORY_PAGE_SIZE
  const separator = path.includes('?') ? '&' : '?'
  const response = await koios.batchPageOnce(
    addressTxRow,
    `${path}${separator}limit=${limit}&offset=${stream.offset}`,
    stream.body,
  )
  const page = response.rows

  if (response.range === null) {
    if (response.status === 206 || stream.offset !== 0) {
      throw new MalformedUpstreamError(
        `koios omitted Content-Range from a partial response for ${path}`,
      )
    }
    if (page.length >= limit) {
      throw new MalformedUpstreamError(
        `koios returned a full page without Content-Range for ${path}`,
      )
    }
    stream.offset += page.length
    stream.done = true
  } else if (!('start' in response.range)) {
    if (page.length !== 0 || response.range.total !== stream.offset) {
      throw new MalformedUpstreamError(
        `koios returned a contradictory empty Content-Range on ${path}`,
      )
    }
    stream.done = true
  } else {
    const range = response.range
    if (range.start !== stream.offset || page.length !== range.end - range.start + 1) {
      throw new MalformedUpstreamError(`koios returned a non-contiguous page for ${path}`)
    }
    stream.offset = range.end + 1
    if (stream.offset > HISTORY_MAX_LIST_ROWS) {
      throw new MalformedUpstreamError(
        `koios paged result exceeds ${HISTORY_MAX_LIST_ROWS} rows for ${path}`,
      )
    }
    // PostgREST uses 206 for every partial response, including a short final page. Completion
    // is therefore determined by the range total; accepting a short 200 page would allow an
    // upstream that omitted rows to be mistaken for a complete history.
    stream.done = stream.offset === range.total
    if (!stream.done && response.status !== 206) {
      throw new MalformedUpstreamError(
        `koios returned an incomplete successful response for ${path}`,
      )
    }
  }

  for (const row of page) {
    if (stream.last !== undefined && compareAddressTxRows(stream.last, row) > 0) {
      throw new MalformedUpstreamError(`koios returned an out-of-order page for ${path}`)
    }
    stream.last = row
  }
  stream.rows = page
  stream.index = 0
}

async function peekAddressHistoryStream(
  koios: KoiosClient,
  stream: AddressHistoryStream,
  path: string,
): Promise<AddressTxRow | undefined> {
  await fillAddressHistoryStream(koios, stream, path)
  return stream.rows[stream.index]
}

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
 * The whole UTxO set is fetched because a wallet balance cannot be a plausible partial snapshot.
 * History uses a separate incremental merge below because its public contract is one bounded
 * transaction page, not the whole matching set.
 */
function pagedBatchAll<Row>(
  koios: KoiosClient,
  rowSchema: z.ZodType<Row>,
  path: string,
  addresses: string[],
  toBody: (chunk: string[]) => unknown,
  rowKey?: (row: Row) => string,
): Promise<Row[]> {
  const options =
    rowKey === undefined
      ? undefined
      : {
          rowKey,
          keyset: (row: Row): readonly [string, number] => {
            const value = row as { tx_hash?: unknown; tx_index?: unknown }
            if (typeof value.tx_hash !== 'string' || typeof value.tx_index !== 'number') {
              throw new TypeError('koios UTxO keyset requires tx_hash and tx_index')
            }
            return [value.tx_hash, value.tx_index]
          },
        }
  return koios.packAdaptively(addresses, toBody, (body) =>
    koios.batchAllPages(rowSchema, path, body, options),
  )
}

async function boundedAddressHistoryRows(
  koios: KoiosClient,
  addresses: string[],
  afterBlock?: number,
): Promise<AddressTxRow[]> {
  const path = '/address_txs?order=block_height.asc,tx_hash.asc'
  const toBody = (chunk: string[]): unknown => ({
    _addresses: chunk,
    ...(afterBlock === undefined ? {} : { _after_block_height: afterBlock }),
  })

  // Start one incrementally paged, ordered stream per adaptively packed request body. Returning
  // the stream in a one-item array lets packAdaptively retain its 413 limit learning without
  // forcing any stream to walk its irrelevant tail.
  const streams = await koios.packAdaptively<AddressHistoryStream, string>(
    addresses,
    toBody,
    async (body) => {
      const stream: AddressHistoryStream = {
        body,
        rows: [],
        index: 0,
        offset: 0,
        done: false,
      }
      await fillAddressHistoryStream(koios, stream, path)
      return [stream]
    },
  )

  const distinct = new Map<string, AddressTxRow>()
  let boundaryBlock: number | undefined

  for (;;) {
    const heads = await Promise.all(
      streams.map(async (stream) => ({
        stream,
        row: await peekAddressHistoryStream(koios, stream, path),
      })),
    )
    let next: { stream: AddressHistoryStream; row: AddressTxRow } | undefined
    for (const head of heads) {
      if (head.row === undefined) continue
      if (next === undefined || compareAddressTxRows(head.row, next.row) < 0) {
        next = { stream: head.stream, row: head.row }
      }
    }
    if (next === undefined) break
    if (boundaryBlock !== undefined && next.row.block_height > boundaryBlock) break

    next.stream.index += 1
    if (!distinct.has(next.row.tx_hash)) {
      distinct.set(next.row.tx_hash, next.row)
      if (distinct.size === HISTORY_PAGE_SIZE) boundaryBlock = next.row.block_height
    }
  }

  return [...distinct.values()]
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
      // that come back are the used set. Pack against the shared body limit so large valid
      // address sets inherit the client's proactive chunking and adaptive 413 retry.
      const rows = await koios.batchAll(addressRow, '/address_info', addresses, (chunk) => ({
        _addresses: chunk,
      }))
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
      const results: string[][] = new Array(groups.length)
      let nextGroup = 0
      await Promise.all(
        Array.from({ length: Math.min(CREDENTIAL_PROBE_CONCURRENCY, groups.length) }, async () => {
          while (nextGroup < groups.length) {
            const index = nextGroup++
            results[index] = await usedPaymentCredentials(groups[index]!)
          }
        }),
      )
      const used = new Set(results.flat())
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

      // Each packed address body is an ordered stream. Merge their oldest heads incrementally
      // until the first 50 distinct transactions and the whole boundary block are known, instead
      // of walking every active address to the end before throwing almost all of it away.
      const rows = await koios.readWithRetry('/address_txs', () =>
        boundedAddressHistoryRows(koios, addresses, afterBlock),
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

      // The bounded merge already selected one page, oldest first, without cutting through its
      // boundary block. Keep the final sort/window here as a defensive statement of the public
      // contract and to make the selection independent of stream scheduling.
      const sorted = distinct.sort((a, b) => a.block_height - b.block_height)
      let end = Math.min(HISTORY_PAGE_SIZE, sorted.length)
      const boundaryBlock = sorted[end - 1]?.block_height
      while (end < sorted.length && sorted[end]?.block_height === boundaryBlock) end += 1
      const hashes = sorted.slice(0, end).map((r) => r.tx_hash)

      return hydrateTxHistory(koios, hashes)
    },
  }
}
