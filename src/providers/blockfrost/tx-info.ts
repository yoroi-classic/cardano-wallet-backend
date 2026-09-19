import { z } from 'zod'
import type {
  CertificateKind,
  ResolvedUtxo,
  TxCertificate,
  TxIo,
  WalletTransaction,
  Withdrawal,
} from '../../domain/types/transactions.js'
import type { BlockfrostClient } from './client.js'
import { mapWithConcurrency } from './concurrency.js'
import { amountList, numeric, splitAmount } from './schema.js'

/**
 * The transaction-hydration helper shared by every history and utxo-by-reference read, mirroring
 * koios/tx-info.ts's role.
 *
 * Koios answers a whole transaction — inputs, outputs, withdrawals, certificates, metadata — from a
 * single `/tx_info` row. Blockfrost has no equivalent: the same detail is spread across `/txs/{hash}`
 * (fee, block, slot, ttl, and per-kind certificate counts), `/txs/{hash}/utxos` (inputs and outputs,
 * with inline datum and reference script), `/txs/{hash}/withdrawals`, the certificate sub-resources
 * (`/stakes`, `/delegations`, `/mirs`, `/pool_updates`, `/pool_retires`), `/txs/{hash}/metadata`, and
 * `/blocks/{hash}` (the epoch, which `/txs/{hash}` alone does not carry). This module stitches those
 * back into the one shared `WalletTransaction` shape so a client cannot tell the two providers apart.
 *
 * Every request goes through the injected client, so it is paced by the shared rate limiter; the
 * fan-out across transactions is bounded by the caller's concurrency ceiling.
 */

// How many transactions a single history page details, matching koios/account.ts and the extension's
// request size.
export const HISTORY_PAGE_SIZE = 50

// Blockfrost's own documented maximum rows per page.
const LIST_PAGE_SIZE = 100
// Far above any realistic wallet; keeps a per-address walk bounded if a page ever stops shrinking,
// the same defensive bound the account-utxo scan uses.
const LIST_MAX_PAGES = 200

// Bounded fan-out ceilings. Each unit of work is itself several paced requests, so a modest ceiling
// overlaps the round trips without opening hundreds of authenticated connections at once and
// draining Blockfrost's burst bucket for the whole batch. See concurrency.ts and rate-limiter.ts.
export const ADDRESS_FANOUT = 10
export const HYDRATE_FANOUT = 10

/** `tx_content` (Blockfrost OpenAPI spec, `/txs/{hash}`), projected to what a WalletTransaction needs. */
const txContentRow = z.object({
  block: z.string(),
  block_height: z.number().int().nonnegative(),
  block_time: z.number().int().nonnegative(),
  slot: z.number().int().nonnegative(),
  // Position within the block, used only to order the hydrated page deterministically.
  index: z.number().int().nonnegative(),
  fees: numeric,
  // Right (excluded) endpoint of the validity interval: the transaction's ttl, when it set one.
  invalid_hereafter: numeric.nullish(),
  // Per-kind certificate counts. Each gates whether the matching sub-resource is fetched at all, so
  // a plain payment (every count zero) is hydrated without a single certificate round trip.
  withdrawal_count: z.number().int().nonnegative(),
  delegation_count: z.number().int().nonnegative(),
  stake_cert_count: z.number().int().nonnegative(),
  mir_cert_count: z.number().int().nonnegative(),
  pool_update_count: z.number().int().nonnegative(),
  pool_retire_count: z.number().int().nonnegative(),
})

/** `/blocks/{hash}`, projected to the one field `/txs/{hash}` omits: the epoch. */
const blockRow = z.object({
  // Nullable in the spec (a Byron epoch-boundary block has none), but a block that contains a
  // transaction always has a real epoch, so a null here on a tx's block is malformed upstream data.
  epoch: z.number().int().nonnegative(),
})

/** One input on `tx_content_utxo` (`/txs/{hash}/utxos`). */
const utxoInputRow = z.object({
  address: z.string(),
  amount: amountList,
  // A collateral input is only consumed on a script-validation failure, and a reference input is
  // never consumed at all. Neither is a real spend, so both are dropped to match Koios's `inputs`,
  // which lists regular inputs only (collateral and reference live on separate Koios fields).
  collateral: z.boolean(),
  reference: z.boolean().nullish(),
})

/** One output on `tx_content_utxo` (`/txs/{hash}/utxos`), carrying datum and reference-script detail. */
const utxoOutputRow = z.object({
  address: z.string(),
  amount: amountList,
  output_index: z.number().int().nonnegative(),
  data_hash: z.string().nullish(),
  inline_datum: z.string().nullish(),
  reference_script_hash: z.string().nullish(),
  // Whether this is the collateral return of a failed script transaction. Required by the spec, so
  // read strictly: it decides which of the two spent-state sources below applies, and a silently
  // absent flag would route a collateral output down the path that cannot answer for it.
  collateral: z.boolean(),
  // Transaction that consumed this output, or null/absent for an unconsumed one. This answers
  // "spent" without a second query, but *only for an ordinary output*. The spec is explicit that it
  // is "Always null for collateral outputs", spent or not, so on a collateral output a null here
  // carries no information at all and must not be read as unspent. See resolveCollateralSpent.
  consumed_by_tx: z.string().nullish(),
})

// One row of `address_utxo_content` (`/addresses/{address}/utxos`), projected to just the reference.
// Only used to test set membership, so nothing else on the row is read.
const addressUtxoRefRow = z.object({
  tx_hash: z.string(),
  output_index: z.number().int().nonnegative(),
})

const txUtxosRow = z.object({
  inputs: z.array(utxoInputRow),
  outputs: z.array(utxoOutputRow),
})

/** The parsed inputs/outputs of a transaction, shared by history hydration and by-reference lookups. */
export type TxUtxos = z.infer<typeof txUtxosRow>

const withdrawalRow = z.object({ address: z.string(), amount: numeric })
const stakeCertRow = z.object({
  cert_index: z.number().int().nonnegative(),
  // true is a registration, false a deregistration.
  registration: z.boolean(),
})
const certIndexRow = z.object({ cert_index: z.number().int().nonnegative() })
const metadataRow = z.object({ label: z.string(), json_metadata: z.unknown() })

function mapTxIo(row: { address: string; amount: z.infer<typeof amountList> }): TxIo {
  const { value, assets } = splitAmount(row.amount)
  return { address: row.address, value, assets }
}

/**
 * Fold Blockfrost's metadata array (`[{label, json_metadata}]`) into the object-keyed-by-label shape
 * Koios passes through (`{ '674': {...} }`), so `WalletTransaction.metadata` is identical across
 * providers. No metadata is `undefined`, matching Koios's null-to-undefined normalization.
 */
function mapMetadata(rows: z.infer<typeof metadataRow>[]): unknown {
  if (rows.length === 0) return undefined
  const out: Record<string, unknown> = {}
  for (const row of rows) out[row.label] = row.json_metadata
  return out
}

/**
 * The epoch of a block, memoized per hydration run. Transactions in a history page frequently share
 * a block (and always share the containing epoch within it), so caching the lookup collapses the
 * extra `/blocks` round trip to one per distinct block. A Promise is cached rather than the resolved
 * value so concurrent hydrations of the same block issue a single request.
 */
function epochOf(
  client: BlockfrostClient,
  blockHash: string,
  cache: Map<string, Promise<number>>,
): Promise<number> {
  const cached = cache.get(blockHash)
  if (cached !== undefined) return cached
  const pending = client
    .get(blockRow, `/blocks/${encodeURIComponent(blockHash)}`)
    .then((block) => block.epoch)
  cache.set(blockHash, pending)
  return pending
}

async function fetchCertificates(
  client: BlockfrostClient,
  hash: string,
  tx: z.infer<typeof txContentRow>,
): Promise<TxCertificate[]> {
  const path = (suffix: string): string => `/txs/${encodeURIComponent(hash)}/${suffix}`

  // Read the stake registrations apart from the index-only kinds: only this resource carries the
  // registration/deregistration flag that decides its normalized kind.
  const stakeCerts = (): Promise<TxCertificate[]> =>
    client.get(z.array(stakeCertRow), path('stakes')).then((rows) =>
      rows.map<TxCertificate>((row) => ({
        kind: row.registration ? 'stake_registration' : 'stake_deregistration',
        index: row.cert_index,
      })),
    )

  const indexCerts =
    (suffix: string, kind: CertificateKind): (() => Promise<TxCertificate[]>) =>
    () =>
      client
        .get(z.array(certIndexRow), path(suffix))
        .then((rows) => rows.map<TxCertificate>((row) => ({ kind, index: row.cert_index })))

  // Only the sub-resources whose count is non-zero are read, and those are read concurrently — each
  // is an independent request, still paced by the shared limiter. A plain payment (every count zero)
  // issues no certificate request at all.
  const fetches: Promise<TxCertificate[]>[] = []
  if (tx.stake_cert_count > 0) fetches.push(stakeCerts())
  if (tx.delegation_count > 0) fetches.push(indexCerts('delegations', 'stake_delegation')())
  if (tx.mir_cert_count > 0) fetches.push(indexCerts('mirs', 'move_instantaneous_rewards')())
  if (tx.pool_update_count > 0) fetches.push(indexCerts('pool_updates', 'pool_registration')())
  if (tx.pool_retire_count > 0) fetches.push(indexCerts('pool_retires', 'pool_retirement')())

  const groups = await Promise.all(fetches)
  // Certificate index is unique within a transaction across every kind, so ordering by it puts the
  // certificates back in their on-chain order regardless of which sub-resource each came from.
  return groups.flat().sort((a, b) => a.index - b.index)
}

interface HydratedTx {
  tx: WalletTransaction
  // Position within the block, kept out of the domain shape but used to order the page.
  blockIndex: number
}

async function hydrateOne(
  client: BlockfrostClient,
  hash: string,
  epochCache: Map<string, Promise<number>>,
): Promise<HydratedTx> {
  const base = `/txs/${encodeURIComponent(hash)}`
  // These three are independent of each other, so overlap them; the client's limiter still paces the
  // requests against the shared budget.
  const [tx, utxos, metadata] = await Promise.all([
    client.get(txContentRow, base),
    client.get(txUtxosRow, `${base}/utxos`),
    client.get(z.array(metadataRow), `${base}/metadata`),
  ])

  const [epoch, withdrawals, certificates] = await Promise.all([
    epochOf(client, tx.block, epochCache),
    tx.withdrawal_count > 0
      ? client.get(z.array(withdrawalRow), `${base}/withdrawals`).then((rows) =>
          rows.map<Withdrawal>((row) => ({
            stakeAddress: row.address,
            amount: String(row.amount),
          })),
        )
      : Promise.resolve<Withdrawal[]>([]),
    fetchCertificates(client, hash, tx),
  ])

  const inputs = utxos.inputs
    .filter((input) => !input.collateral && input.reference !== true)
    .map(mapTxIo)

  return {
    blockIndex: tx.index,
    tx: {
      txHash: hash,
      block: tx.block_height,
      blockHash: tx.block,
      slot: tx.slot,
      epoch,
      blockTime: tx.block_time,
      fee: String(tx.fees),
      ttl: tx.invalid_hereafter != null ? Number(tx.invalid_hereafter) : undefined,
      inputs,
      outputs: utxos.outputs.map(mapTxIo),
      withdrawals,
      certificates,
      metadata: mapMetadata(metadata),
    },
  }
}

/**
 * Detail a set of transaction hashes into full WalletTransactions, oldest first.
 *
 * Ordered on (block height, index within block), the same total order koios/tx-info.ts sorts its
 * hydrated page by, so both providers return a page in the same sequence. The fan-out is bounded by
 * `concurrency`; a hash that has rolled back since it was listed surfaces the underlying error loudly
 * rather than silently leaving a hole, matching the Koios hydration's fail-closed stance.
 */
export async function hydrateTransactions(
  client: BlockfrostClient,
  hashes: string[],
  concurrency: number = HYDRATE_FANOUT,
): Promise<WalletTransaction[]> {
  if (hashes.length === 0) return []
  const epochCache = new Map<string, Promise<number>>()
  const hydrated = await mapWithConcurrency(hashes, concurrency, (hash) =>
    hydrateOne(client, hash, epochCache),
  )
  return hydrated
    .sort((a, b) => a.tx.block - b.tx.block || a.blockIndex - b.blockIndex)
    .map((entry) => entry.tx)
}

/** One thin address-transaction row (`address_transactions_content`, `/addresses/{address}/transactions`). */
const addressTxRow = z.object({
  tx_hash: z.string(),
  tx_index: z.number().int().nonnegative(),
  block_height: z.number().int().nonnegative(),
})
type AddressTxRow = z.infer<typeof addressTxRow>

/**
 * One address's incremental paging state. Rows are accumulated oldest-first; `full` records whether
 * the last page came back at the page limit (so more may exist), and `done` latches once the address
 * is exhausted or a 404 says it was never seen.
 */
interface AddressCursor {
  address: string
  page: number
  rows: AddressTxRow[]
  full: boolean
  done: boolean
}

/**
 * Fetch one more page for an address and fold it into the cursor, applying the exclusive `> afterBlock`
 * cut as rows arrive. `afterBlock` is pushed to Blockfrost as an inclusive `from` bound so old history
 * is never fetched in the first place; the exact `>` cut trims the one boundary block `from` still
 * includes. A never-seen address answers 404, which is "no history", not an error, and latches `done`.
 */
async function advanceCursor(
  client: BlockfrostClient,
  cursor: AddressCursor,
  afterBlock: number | undefined,
): Promise<void> {
  if (cursor.done) return
  cursor.page += 1
  const from = afterBlock === undefined ? '' : `&from=${afterBlock}`
  const pageRows = await client.getOrUndefined(
    z.array(addressTxRow),
    `/addresses/${encodeURIComponent(cursor.address)}/transactions?count=${LIST_PAGE_SIZE}&page=${cursor.page}&order=asc${from}`,
  )
  if (pageRows === undefined) {
    cursor.done = true
    return
  }
  for (const row of pageRows) {
    if (afterBlock === undefined || row.block_height > afterBlock) cursor.rows.push(row)
  }
  cursor.full = pageRows.length === LIST_PAGE_SIZE
  if (!cursor.full) cursor.done = true
  if (cursor.page >= LIST_MAX_PAGES) cursor.done = true
}

/**
 * Merge every cursor's rows into the oldest-first page: dedup by tx hash (a self-transfer touching
 * several addresses appears once), then take `HISTORY_PAGE_SIZE` and extend to the whole boundary
 * block so the next `afterBlock` cursor cannot skip the rest of it. Returns the page rows and the
 * boundary block, or `undefined` for the boundary when nothing matched.
 */
function mergePage(cursors: AddressCursor[]): { page: AddressTxRow[]; boundaryBlock?: number } {
  const byHash = new Map<string, AddressTxRow>()
  for (const cursor of cursors) {
    for (const row of cursor.rows) if (!byHash.has(row.tx_hash)) byHash.set(row.tx_hash, row)
  }
  if (byHash.size === 0) return { page: [] }

  const sorted = [...byHash.values()].sort(
    (a, b) => a.block_height - b.block_height || a.tx_index - b.tx_index,
  )
  let end = Math.min(HISTORY_PAGE_SIZE, sorted.length)
  const boundaryBlock = sorted[end - 1]?.block_height
  while (end < sorted.length && sorted[end]?.block_height === boundaryBlock) end += 1
  return { page: sorted.slice(0, end), boundaryBlock }
}

/**
 * Transaction history for a set of addresses, oldest first, hydrated into full WalletTransactions.
 *
 * Shared by the stake-account history (which first enumerates its addresses) and the direct
 * address-set history, so the ordering, dedup, and paging contract is defined once.
 *
 * The cost is bounded by the page size, not by total history. Only the first page of each address is
 * fetched up front; the merged page's boundary block is then completed by pulling further pages *only*
 * from the addresses whose newest fetched transaction still sits inside that block (so it might hold
 * more of it). Because `HISTORY_PAGE_SIZE` is below the request page size, every transaction in the
 * oldest page arrives in that first page per address, so the boundary block is settled after the first
 * round and completion touches at most the few addresses that crowd it — an active address with tens
 * of thousands of transactions costs one request, not one per hundred. `afterBlock` is pushed to
 * Blockfrost as a `from` bound, so history at or before the cursor is never fetched at all.
 */
export async function addressSetTxHistory(
  client: BlockfrostClient,
  addresses: string[],
  afterBlock: number | undefined,
  addressFanout: number = ADDRESS_FANOUT,
  hydrateFanout: number = HYDRATE_FANOUT,
): Promise<WalletTransaction[]> {
  if (addresses.length === 0) return []

  const cursors: AddressCursor[] = addresses.map((address) => ({
    address,
    page: 0,
    rows: [],
    full: false,
    done: false,
  }))

  // First page of every address, under a bounded fan-out.
  await mapWithConcurrency(cursors, addressFanout, (cursor) =>
    advanceCursor(client, cursor, afterBlock),
  )

  // Settle the oldest page: keep pulling pages only from addresses that might still hold transactions
  // relevant to it, recomputing the boundary each round. Two reasons an address still needs pages:
  //  - No post-cursor transaction has surfaced yet (`boundaryBlock` undefined). A full first page can
  //    be entirely transactions in the `afterBlock` block itself — `from=afterBlock` is inclusive, so
  //    those come back but are cut by the exclusive `> afterBlock` filter, leaving the address with no
  //    kept rows. It must keep advancing (its real post-cursor history is on a later page) rather than
  //    be mistaken for exhausted, or the whole read would wrongly return empty.
  //  - The boundary is known, but this address's newest kept transaction still sits inside it, so it
  //    may hold more of that block.
  // Terminates because every extra page is strictly newer (ascending order): an address either crosses
  // the boundary, produces its first post-cursor transaction, or exhausts; `LIST_MAX_PAGES` backstops.
  for (;;) {
    const { boundaryBlock } = mergePage(cursors)
    const needing = cursors.filter((cursor) => {
      if (cursor.done || !cursor.full) return false
      if (boundaryBlock === undefined || cursor.rows.length === 0) return true
      return cursor.rows[cursor.rows.length - 1]!.block_height <= boundaryBlock
    })
    if (needing.length === 0) break
    await mapWithConcurrency(needing, addressFanout, (cursor) =>
      advanceCursor(client, cursor, afterBlock),
    )
  }

  const { page } = mergePage(cursors)
  const hashes = page.map((row) => row.tx_hash)
  return hydrateTransactions(client, hashes, hydrateFanout)
}

/**
 * Fetch a transaction's inputs and outputs, or `undefined` if the transaction is not on chain.
 *
 * Used by the by-reference lookup, where a 404 is the legitimate answer "nothing at this reference"
 * rather than a failure — the same reason koios/tx.ts tolerates an absent utxo_info row.
 */
export function fetchTxUtxos(client: BlockfrostClient, hash: string): Promise<TxUtxos | undefined> {
  return client.getOrUndefined(txUtxosRow, `/txs/${encodeURIComponent(hash)}/utxos`)
}

/**
 * Whether a collateral output has since been consumed, or `undefined` if that cannot be established.
 *
 * `consumed_by_tx` is null on every collateral output whether or not it has been spent, so the
 * transaction's own utxo view cannot answer this one. The controlling address's live utxo set can:
 * an output is unspent exactly while it is still listed there. Walked newest first, so a collateral
 * return, which is by nature recent, is normally settled by the first page.
 *
 * The `undefined` case is deliberate. `spent` has no third value, and of the two, answering
 * "unspent" for an output that has actually gone is the one that does damage: a wallet offering it
 * as collateral builds a transaction the node rejects. So an inconclusive walk is reported as
 * nothing at that reference rather than guessed either way.
 */
async function resolveCollateralSpent(
  client: BlockfrostClient,
  address: string,
  txHash: string,
  outputIndex: number,
): Promise<boolean | undefined> {
  const path = `/addresses/${encodeURIComponent(address)}/utxos`
  const wanted = txHash.toLowerCase()

  for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
    const rows = await client.getOrUndefined(
      z.array(addressUtxoRefRow),
      `${path}?count=${LIST_PAGE_SIZE}&page=${page}&order=desc`,
    )
    // An address Blockfrost has never seen controls nothing, so the output is not in its set.
    if (rows === undefined) return true
    const held = rows.some(
      (row) => row.tx_hash.toLowerCase() === wanted && row.output_index === outputIndex,
    )
    if (held) return false
    // A short page ends the set: walked it all without finding the output, so it is gone.
    if (rows.length < LIST_PAGE_SIZE) return true
  }

  return undefined
}

/**
 * Establish the spent state of one referenced output.
 *
 * Two sources, because Blockfrost only populates `consumed_by_tx` on ordinary outputs. An ordinary
 * output is answered from the transaction read already in hand; a collateral output costs one more
 * address-scoped read, paid only by the references that need it.
 */
export function resolveOutputSpent(
  client: BlockfrostClient,
  txHash: string,
  outputIndex: number,
  output: TxUtxos['outputs'][number],
): Promise<boolean | undefined> {
  // A consuming transaction hash is conclusive on any output. The spec says it is never set on a
  // collateral one, but if that ever changes it is still the cheapest true answer available.
  if (typeof output.consumed_by_tx === 'string') return Promise.resolve(true)
  // Its *absence* is only conclusive on an ordinary output.
  if (!output.collateral) return Promise.resolve(false)
  return resolveCollateralSpent(client, output.address, txHash, outputIndex)
}

/** Map one `/txs/{hash}/utxos` output onto the resolved-by-reference domain shape. */
export function mapResolvedOutput(
  txHash: string,
  outputIndex: number,
  output: TxUtxos['outputs'][number],
  spent: boolean,
): ResolvedUtxo {
  const { value, assets } = splitAmount(output.amount)
  return {
    txHash,
    outputIndex,
    address: output.address,
    value,
    assets,
    datumHash: output.data_hash ?? undefined,
    inlineDatum: output.inline_datum ?? undefined,
    referenceScriptHash: output.reference_script_hash ?? undefined,
    // Decided by resolveOutputSpent, which knows which source can answer for this output.
    spent,
  }
}
