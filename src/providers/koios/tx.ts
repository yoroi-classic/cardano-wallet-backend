import { z } from 'zod'
import { BadRequestError, MalformedUpstreamError } from '../../domain/errors.js'
import type { TxStatus } from '../../domain/types/transactions.js'
import type { TxCapability } from '../capabilities/tx.js'
import type { KoiosClient } from './client.js'

const txStatusRow = z.object({
  tx_hash: z.string(),
  // A confirmation count is a number of blocks on top: a whole, non-negative one.
  num_confirmations: z.number().int().nonnegative().nullish(),
})

const txHashRow = z.string().regex(/^[0-9a-fA-F]{64}$/)

export function createTxMethods(koios: KoiosClient): TxCapability {
  return {
    async submitTx(cborHex: string): Promise<{ txHash: string }> {
      if (!/^[0-9a-fA-F]+$/.test(cborHex) || cborHex.length % 2 !== 0) {
        throw new BadRequestError('transaction must be a hex-encoded CBOR string')
      }
      // submit(), never a read: a transaction resent because the first response was garbled is
      // a double-spend, so this call has no retry path. See the note on KoiosClient.
      // A Buffer is already a Uint8Array, so the body goes out as-is rather than being copied.
      const txHash = await koios.submit(
        txHashRow,
        '/submittx',
        Buffer.from(cborHex, 'hex'),
        'application/cbor',
      )
      return { txHash }
    },

    async getTxStatus(hash: string): Promise<TxStatus> {
      const rows = await koios.batch(z.array(txStatusRow), '/tx_status', { _tx_hashes: [hash] })

      // Match the row to the hash we asked about rather than trusting rows[0]. A
      // mismatched response would otherwise report another transaction's confirmations as
      // this one's, which for a wallet means telling someone a payment landed when it did
      // not. No rows at all is legitimate: the transaction simply isn't on chain yet.
      const row = rows.find((r) => r.tx_hash === hash)
      if (rows.length > 0 && row === undefined) {
        throw new MalformedUpstreamError('koios returned tx_status rows for a different tx')
      }

      const confirmations = row?.num_confirmations ?? null
      return { seen: confirmations !== null, confirmations: confirmations ?? 0 }
    },
  }
}
