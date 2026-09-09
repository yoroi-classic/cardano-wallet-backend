import { z } from 'zod'
import type { BlockfrostClient } from './client.js'
import { mapWithConcurrency } from './concurrency.js'

/**
 * Creation-block heights for Blockfrost UTxO reads.
 *
 * Koios puts `block_height` directly on every UTxO row, so its drivers read provenance for free.
 * Blockfrost does not: `address_utxo_content` and `account_utxo_content` both carry `block`, the
 * creation block's *hash*, and no height anywhere on the row. Turning that into the height the
 * contract promises costs one `/blocks/{hash}` per distinct block.
 *
 * Per distinct block, not per UTxO, is what makes this affordable. A wallet's outputs cluster
 * heavily into the blocks that paid it, so a set of dozens of UTxOs typically spans far fewer
 * blocks, and change outputs from one transaction collapse to a single lookup.
 *
 * The lookups are resolved together, before mapping, rather than lazily per row: the whole row set
 * is already in hand at that point, so the distinct blocks are known up front and can be fetched
 * with bounded concurrency instead of one at a time.
 */

// How many block lookups this driver keeps in flight at once. The same modest ceiling the address
// reads use: enough to overlap the round trips, not so many that resolving a large UTxO set opens
// a connection per block at once and trips the rate limiter for the whole read.
const BLOCK_LOOKUP_CONCURRENCY = 10

/** `/blocks/{hash}` (Blockfrost OpenAPI spec, `block_content`), projected to the height. */
const blockHeightRow = z.object({
  // Nullable in the spec, because a Byron epoch-boundary block has no height. An EBB contains no
  // transactions, so it can never be the creation block of a UTxO; a null here is malformed
  // upstream data rather than a case to tolerate. Read strictly for the same reason the field is
  // required on the public shape: a defaulted or omitted height is a fabricated provenance, and it
  // would be persisted by the client as though we had authority for it.
  height: z.number().int().nonnegative(),
})

/**
 * Resolve each distinct block hash to its height.
 *
 * Duplicates cost nothing: the input is reduced to its distinct members first, and the returned
 * map is keyed by hash, so callers look up per row without tracking which lookups they caused.
 *
 * A block that has rolled back between the UTxO walk and this lookup fails the whole read, and
 * that is deliberate. This function serves the account- and address-keyed reads, which answer
 * "the complete set of outputs this wallet controls". A set quietly missing an output is a wrong
 * balance: the wallet undercounts its funds and can refuse to build a transaction it could
 * afford. An error is transient and the caller retries onto a consistent set, so it is the less
 * damaging of the two. The account walk already takes this position for the same reason, failing
 * with "blockfrost account utxos changed during paged read; retry" when its scan sees churn.
 *
 * `resolveTxBlockHeights` below drops instead, and the difference is the question being asked
 * rather than an inconsistency. See its note.
 */
export async function resolveBlockHeights(
  client: BlockfrostClient,
  blockHashes: Iterable<string>,
): Promise<Map<string, number>> {
  const distinct = [...new Set(blockHashes)]
  const entries = await mapWithConcurrency(
    distinct,
    BLOCK_LOOKUP_CONCURRENCY,
    async (hash): Promise<[string, number]> => {
      const block = await client.get(blockHeightRow, `/blocks/${encodeURIComponent(hash)}`)
      return [hash, block.height]
    },
  )
  return new Map(entries)
}

/** `/txs/{hash}` (Blockfrost OpenAPI spec, `tx_content`), projected to the containing block height. */
const txBlockHeightRow = z.object({
  block_height: z.number().int().nonnegative(),
})

/**
 * Creation heights for outputs resolved *by reference*.
 *
 * The by-reference read works from `/txs/{hash}/utxos`, which carries no block information at all,
 * so the containing block cannot be read off the row the way the address and account walks read
 * theirs. `/txs/{hash}` carries the height directly, which makes this one lookup per distinct
 * referenced transaction rather than the two a hash-then-block round trip would cost.
 *
 * A transaction that has gone from the chain between the two reads is absent from the map rather
 * than an error. The caller drops that reference, which is the same "nothing here" answer it
 * already gives for a reference that never existed.
 *
 * Dropping is right here and wrong for the reads above, because the question differs. A caller
 * asking about specific references is told per reference what could be resolved, and absence is
 * already part of that contract. A caller asking for everything a wallet controls cannot tell a
 * dropped output from one that was never there, so it would silently read a wrong balance.
 */
export async function resolveTxBlockHeights(
  client: BlockfrostClient,
  txHashes: Iterable<string>,
): Promise<Map<string, number>> {
  const distinct = [...new Set(txHashes)]
  const entries = await mapWithConcurrency(
    distinct,
    BLOCK_LOOKUP_CONCURRENCY,
    async (hash): Promise<[string, number] | undefined> => {
      const tx = await client.getOrUndefined(txBlockHeightRow, `/txs/${encodeURIComponent(hash)}`)
      return tx === undefined ? undefined : [hash, tx.block_height]
    },
  )
  return new Map(entries.filter((entry): entry is [string, number] => entry !== undefined))
}
