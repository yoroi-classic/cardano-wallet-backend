import { z } from 'zod'
import {
  BadRequestError,
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../../domain/errors.js'
import {
  confirmedTxStatus,
  pendingTxStatus,
  unknownTxStatus,
  type ResolvedUtxo,
  type TxStatus,
} from '../../domain/types/transactions.js'
import type { TxCapability } from '../capabilities/tx.js'
import type { BlockfrostClient } from './client.js'
import { mapWithConcurrency } from './concurrency.js'
import { resolveTxBlockHeights } from './blocks.js'
import { fetchTxUtxos, mapResolvedOutput, resolveOutputSpent, type TxUtxos } from './tx-info.js'

// How many distinct transactions this driver resolves at once. Each reference lookup is a single
// `/txs/{hash}/utxos` read, so a modest ceiling overlaps them without draining the burst bucket.
const REF_LOOKUP_CONCURRENCY = 10

// A parsed output reference. A bare `txHash#index`, split once so several references to the same
// transaction share one upstream read.
interface OutputRef {
  ref: string
  hash: string
  index: number
}

/**
 * Parse a `txHash#index` reference, or `undefined` if it is not one.
 *
 * Leniently, on purpose: an unparseable or not-on-chain reference is answered by absence from the
 * result, never an error, exactly as koios/tx.ts treats a reference with no `utxo_info` row. So a
 * malformed reference is simply dropped here rather than failing the whole batch.
 */
function parseRef(ref: string): OutputRef | undefined {
  const hash = ref.slice(0, ref.indexOf('#'))
  const indexPart = ref.slice(ref.indexOf('#') + 1)
  if (!/^[0-9a-fA-F]{64}$/.test(hash) || !/^\d+$/.test(indexPart)) return undefined
  const index = Number(indexPart)
  if (!Number.isSafeInteger(index)) return undefined
  return { ref, hash: hash.toLowerCase(), index }
}

/** Identifies the output a reference points at, so two references to it resolve their state once. */
function spentKey(ref: OutputRef): string {
  return `${ref.hash}#${ref.index}`
}

// Blockfrost's `/tx/submit` answers with a bare JSON string (the tx hash), not an object.
const txHashSchema = z.string().regex(/^[0-9a-fA-F]{64}$/)

// A minimal projection of `tx_content` (Blockfrost OpenAPI spec, `/txs/{hash}`): just enough to
// find the block that mined this transaction.
const txRow = z.object({
  block: z.string(),
})

// A minimal projection of `block_content` (Blockfrost OpenAPI spec, `/blocks/{hash_or_number}`).
const blockRow = z.object({
  confirmations: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})

// Deliberately project only the hash. Blockfrost's mempool response also carries inputs, outputs,
// validity bounds and other transaction material that this endpoint must neither retain nor return.
const mempoolRow = z.object({
  tx: z.object({
    hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  }),
})

export function createTxMethods(client: BlockfrostClient): TxCapability {
  return {
    async submitTx(cborHex: string): Promise<{ txHash: string }> {
      if (!/^[0-9a-fA-F]+$/.test(cborHex) || cborHex.length % 2 !== 0) {
        throw new BadRequestError('transaction must be a hex-encoded CBOR string')
      }
      // submit(), never a read: a transaction resent because the first response was garbled is
      // a double-spend, so this call has no retry path. See the note on BlockfrostClient.
      const txHash = await client.submit(
        txHashSchema,
        '/tx/submit',
        Buffer.from(cborHex, 'hex'),
        'application/cbor',
      )
      return { txHash }
    },

    async getTxStatus(hash: string): Promise<TxStatus> {
      // Keep direct provider callers consistent with the HTTP boundary: Blockfrost keys this path
      // by canonical lowercase hex, while hash spelling itself is case-insensitive.
      const normalizedHash = hash.toLowerCase()
      const tx = await client.getOrUndefined(txRow, `/txs/${encodeURIComponent(normalizedHash)}`)
      // Not on chain at all — 404 here is a legitimate answer, not a failure. The transaction
      // may simply not have propagated yet.
      if (tx === undefined) {
        // The hosted Blockfrost API exposes a positive mempool lookup for transactions submitted
        // through Blockfrost. A hit proves pending. A miss proves nothing: the transaction might
        // be propagating elsewhere, might have left the mempool between our two reads, or this may
        // be a compatible/self-hosted deployment without the hosted mempool index.
        let mempool: z.infer<typeof mempoolRow> | undefined
        try {
          mempool = await client.getOrUndefined(
            mempoolRow,
            `/mempool/${encodeURIComponent(normalizedHash)}`,
          )
        } catch (error) {
          // Mempool is enrichment only. Hosted Blockfrost answers a miss with 404, while
          // compatibility-mode/self-hosted deployments may answer an unregistered route with
          // 400 (or another transient transport/status error). None of those should turn the
          // already-valid "not on chain" answer into a 502. Keep malformed payloads and the
          // explicit hash-mismatch check below loud: they indicate an upstream contract problem.
          if (!(error instanceof ProviderError || error instanceof ProviderTimeoutError)) {
            throw error
          }
          return unknownTxStatus()
        }
        if (mempool === undefined) return unknownTxStatus()
        if (mempool.tx.hash.toLowerCase() !== normalizedHash) {
          throw new MalformedUpstreamError(
            'blockfrost returned mempool content for a different transaction',
          )
        }
        return pendingTxStatus()
      }

      // `tx_content` carries the containing block's hash but not a confirmation count.
      // `block_content` has exactly that field, so this is a second, cheap lookup rather than
      // arithmetic against a separately-fetched tip — which keeps this module self-contained,
      // with no dependency injected from the provider's chain module the way the Koios pool
      // ranking needs the current epoch.
      const block = await client.get(blockRow, `/blocks/${encodeURIComponent(tx.block)}`)
      return confirmedTxStatus(block.confirmations)
    },

    async getUtxosByRef(refs: string[]): Promise<ResolvedUtxo[]> {
      if (refs.length === 0) return []

      // Resolve each distinct transaction once, then pick the referenced output from it: several
      // references into the same transaction share a single `/txs/{hash}/utxos` read.
      const parsed = refs.map(parseRef)
      const uniqueHashes = [...new Set(parsed.flatMap((p) => (p === undefined ? [] : [p.hash])))]
      const fetched = await mapWithConcurrency(uniqueHashes, REF_LOOKUP_CONCURRENCY, (hash) =>
        fetchTxUtxos(client, hash),
      )
      const byHash = new Map<string, TxUtxos | undefined>()
      uniqueHashes.forEach((hash, i) => byHash.set(hash, fetched[i]))

      // Caller's order. A reference that did not parse, whose transaction is not on chain, or whose
      // output index does not exist is simply absent from the result, so it can be shorter than the
      // request — the same "nothing here" contract as the Koios driver.
      const found = parsed.flatMap((p) => {
        if (p === undefined) return []
        const utxos = byHash.get(p.hash)
        if (utxos === undefined) return []
        const output = utxos.outputs.find((o) => o.output_index === p.index)
        if (output === undefined) return []
        return [{ ref: p, output }]
      })

      // Only a collateral output makes a second request here; an ordinary one is already answered
      // by the transaction read above. Paced under the same ceiling as the reads that fed it, and
      // resolved once per distinct *output* rather than once per reference: the same way several
      // references into one transaction shared a single read above, a reference repeated in the
      // batch must not repeat that output's address scan.
      const bySpentKey = new Map<string, { ref: OutputRef; output: TxUtxos['outputs'][number] }>()
      for (const entry of found) bySpentKey.set(spentKey(entry.ref), entry)
      const distinct = [...bySpentKey.values()]
      const states = await mapWithConcurrency(distinct, REF_LOOKUP_CONCURRENCY, ({ ref, output }) =>
        resolveOutputSpent(client, ref.hash, ref.index, output),
      )
      const spentByKey = new Map<string, boolean | undefined>()
      distinct.forEach((entry, i) => spentByKey.set(spentKey(entry.ref), states[i]))

      // One lookup per distinct referenced transaction, and only for those that produced an
      // output: a reference that did not resolve above costs nothing here.
      const blockHeights = await resolveTxBlockHeights(
        client,
        found.map(({ ref }) => ref.hash),
      )

      return found.flatMap(({ ref, output }) => {
        const spent = spentByKey.get(spentKey(ref))
        // Blockfrost could not establish the spent state. Absent, for the same reason the walk
        // refuses to guess: an output wrongly reported unspent is the one a wallet acts on.
        if (spent === undefined) return []
        const blockHeight = blockHeights.get(ref.hash)
        // The transaction went from the chain between reading its outputs and reading its block.
        // Absent, the same answer this walk already gives for a reference that never existed.
        if (blockHeight === undefined) return []
        return [mapResolvedOutput(ref.hash, ref.index, output, spent, blockHeight)]
      })
    },
  }
}
