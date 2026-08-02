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
import { notImplemented } from './not-implemented.js'

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
      const tx = await client.getOrUndefined(txRow, `/txs/${encodeURIComponent(hash)}`)
      if (tx === undefined) {
        // The hosted Blockfrost API exposes a positive mempool lookup for transactions submitted
        // through Blockfrost. A hit proves pending. A miss proves nothing: the transaction might
        // be propagating elsewhere, might have left the mempool between our two reads, or this may
        // be a compatible/self-hosted deployment without the hosted mempool index.
        let mempool: z.infer<typeof mempoolRow> | undefined
        try {
          mempool = await client.getOrUndefined(mempoolRow, `/mempool/${encodeURIComponent(hash)}`)
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
        if (mempool.tx.hash.toLowerCase() !== hash.toLowerCase()) {
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

    // async so notImplemented()'s synchronous throw becomes a rejected promise rather than
    // escaping the call before a caller's `await` sees it. See the note in assets.ts.
    async getUtxosByRef(_refs: string[]): Promise<ResolvedUtxo[]> {
      // Resolving an arbitrary output reference (spent or not) needs `/txs/{hash}/utxos` per
      // distinct transaction hash referenced, which is a different shape of work than the six
      // endpoints this PR targets. Left for a follow-up; see issue #4's status comment.
      return notImplemented('getUtxosByRef')
    },
  }
}
