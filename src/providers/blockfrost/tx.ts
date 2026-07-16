import { z } from 'zod'
import { BadRequestError } from '../../domain/errors.js'
import type { ResolvedUtxo, TxStatus } from '../../domain/types/transactions.js'
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
