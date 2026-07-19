import { z } from 'zod'
import { BadRequestError } from '../../domain/errors.js'
import type { ResolvedUtxo, TxStatus } from '../../domain/types/transactions.js'
import type { TxCapability } from '../capabilities/tx.js'
import type { BlockfrostClient } from './client.js'
import { mapWithConcurrency } from './concurrency.js'
import { fetchTxUtxos, mapResolvedOutput, type TxUtxos } from './tx-info.js'

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

// Blockfrost's `/tx/submit` answers with a bare JSON string (the tx hash), not an object.
const txHashSchema = z.string().regex(/^[0-9a-fA-F]{64}$/)

// A minimal projection of `tx_content` (Blockfrost OpenAPI spec, `/txs/{hash}`): just enough to
// find the block that mined this transaction.
const txRow = z.object({
  block: z.string(),
})

// A minimal projection of `block_content` (Blockfrost OpenAPI spec, `/blocks/{hash_or_number}`).
const blockRow = z.object({
  confirmations: z.number().int().nonnegative(),
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
      const tx = await client.getOrUndefined(txRow, `/txs/${encodeURIComponent(hash)}`)
      // Not on chain at all — 404 here is a legitimate answer, not a failure. The transaction
      // may simply not have propagated yet.
      if (tx === undefined) return { seen: false, confirmations: 0 }

      // `tx_content` carries the containing block's hash but not a confirmation count.
      // `block_content` has exactly that field, so this is a second, cheap lookup rather than
      // arithmetic against a separately-fetched tip — which keeps this module self-contained,
      // with no dependency injected from the provider's chain module the way the Koios pool
      // ranking needs the current epoch.
      const block = await client.get(blockRow, `/blocks/${encodeURIComponent(tx.block)}`)
      return { seen: true, confirmations: block.confirmations }
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
      return parsed.flatMap((p) => {
        if (p === undefined) return []
        const utxos = byHash.get(p.hash)
        if (utxos === undefined) return []
        const output = utxos.outputs.find((o) => o.output_index === p.index)
        if (output === undefined) return []
        return [mapResolvedOutput(p.hash, p.index, output)]
      })
    },
  }
}
