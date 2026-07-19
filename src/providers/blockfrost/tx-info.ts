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
  // Transaction that consumed this output, or null/absent for an unspent one. This is what lets a
  // by-reference lookup answer "spent" without a second query. Absent means unconsumed, which the
  // spec permits (the field is only serialized when set), so it is read leniently and treated as
  // unspent — the opposite mistake (reading a spent output as unspent) can't arise from an absent
  // field because Blockfrost only omits it when the output really is unspent.
  consumed_by_tx: z.string().nullish(),
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
  const certs: TxCertificate[] = []

  const push = (index: number, kind: CertificateKind): void => {
    certs.push({ kind, index })
  }

  if (tx.stake_cert_count > 0) {
    const rows = await client.get(z.array(stakeCertRow), path('stakes'))
    for (const row of rows) {
      push(row.cert_index, row.registration ? 'stake_registration' : 'stake_deregistration')
    }
  }
  if (tx.delegation_count > 0) {
    const rows = await client.get(z.array(certIndexRow), path('delegations'))
    for (const row of rows) push(row.cert_index, 'stake_delegation')
  }
  if (tx.mir_cert_count > 0) {
    const rows = await client.get(z.array(certIndexRow), path('mirs'))
    for (const row of rows) push(row.cert_index, 'move_instantaneous_rewards')
  }
  if (tx.pool_update_count > 0) {
    const rows = await client.get(z.array(certIndexRow), path('pool_updates'))
    for (const row of rows) push(row.cert_index, 'pool_registration')
  }
  if (tx.pool_retire_count > 0) {
    const rows = await client.get(z.array(certIndexRow), path('pool_retires'))
    for (const row of rows) push(row.cert_index, 'pool_retirement')
  }

  // Certificate index is unique within a transaction across every kind, so ordering by it puts the
  // certificates back in their on-chain order regardless of which sub-resource each came from.
  return certs.sort((a, b) => a.index - b.index)
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
 * Every thin transaction row for one address, oldest first. `afterBlock` is pushed to Blockfrost as
 * an inclusive `from` filter to trim the walk; the exclusive `> afterBlock` cut that matches Koios's
 * cursor semantics is applied by the caller once all addresses are merged. A never-seen address
 * answers 404, which means "no history", not an error.
 */
async function fetchAddressTxRows(
  client: BlockfrostClient,
  address: string,
  afterBlock: number | undefined,
): Promise<AddressTxRow[]> {
  const path = `/addresses/${encodeURIComponent(address)}/transactions`
  const from = afterBlock === undefined ? '' : `&from=${afterBlock}`
  const rows: AddressTxRow[] = []

  for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
    const pageRows = await client.getOrUndefined(
      z.array(addressTxRow),
      `${path}?count=${LIST_PAGE_SIZE}&page=${page}&order=asc${from}`,
    )
    if (pageRows === undefined) return []
    rows.push(...pageRows)
    if (pageRows.length < LIST_PAGE_SIZE) return rows
  }
  return rows
}

/**
 * Transaction history for a set of addresses, oldest first, hydrated into full WalletTransactions.
 *
 * Shared by the stake-account history (which first enumerates its addresses) and the direct
 * address-set history, so the ordering, dedup, and paging contract is defined once. Each address's
 * thin rows are fetched under a bounded fan-out, merged, cut exclusively at `afterBlock`, and
 * collapsed to one row per tx hash — a transaction touching several of the addresses (a self-transfer)
 * would otherwise occupy more than one page slot. The page is taken oldest first and extended to
 * include every transaction sharing its last block, so the next `afterBlock` cursor cannot skip the
 * rest of that block.
 */
export async function addressSetTxHistory(
  client: BlockfrostClient,
  addresses: string[],
  afterBlock: number | undefined,
  addressFanout: number = ADDRESS_FANOUT,
  hydrateFanout: number = HYDRATE_FANOUT,
): Promise<WalletTransaction[]> {
  if (addresses.length === 0) return []

  const perAddress = await mapWithConcurrency(addresses, addressFanout, (address) =>
    fetchAddressTxRows(client, address, afterBlock),
  )

  // Dedup by tx hash while enforcing the exclusive `> afterBlock` cut. First occurrence wins; the
  // rows for one transaction are identical across the addresses it touched.
  const byHash = new Map<string, AddressTxRow>()
  for (const row of perAddress.flat()) {
    if (afterBlock !== undefined && row.block_height <= afterBlock) continue
    if (!byHash.has(row.tx_hash)) byHash.set(row.tx_hash, row)
  }
  if (byHash.size === 0) return []

  const sorted = [...byHash.values()].sort(
    (a, b) => a.block_height - b.block_height || a.tx_index - b.tx_index,
  )
  let end = Math.min(HISTORY_PAGE_SIZE, sorted.length)
  const boundaryBlock = sorted[end - 1]?.block_height
  while (end < sorted.length && sorted[end]?.block_height === boundaryBlock) end += 1
  const hashes = sorted.slice(0, end).map((row) => row.tx_hash)

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

/** Map one `/txs/{hash}/utxos` output onto the resolved-by-reference domain shape. */
export function mapResolvedOutput(
  txHash: string,
  outputIndex: number,
  output: TxUtxos['outputs'][number],
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
    // A consuming transaction hash means spent; null or absent means unspent.
    spent: typeof output.consumed_by_tx === 'string',
  }
}
