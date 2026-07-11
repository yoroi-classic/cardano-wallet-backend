import { z } from 'zod'
import { BadRequestError } from '../../domain/errors.js'
import type { TxStatus } from '../../domain/types/transactions.js'
import type { TxCapability } from '../capabilities/tx.js'
import type { KoiosClient } from './client.js'

const txStatusRow = z.object({
  tx_hash: z.string(),
  num_confirmations: z.number().nullish(),
})

const txHash = z.string().regex(/^[0-9a-fA-F]{64}$/)

export function createTxMethods(koios: KoiosClient): TxCapability {
  return {
    async submitTx(cborHex: string): Promise<{ txHash: string }> {
      if (!/^[0-9a-fA-F]+$/.test(cborHex) || cborHex.length % 2 !== 0) {
        throw new BadRequestError('transaction must be a hex-encoded CBOR string')
      }
      const data = await koios.request('/submittx', {
        method: 'POST',
        body: Uint8Array.from(Buffer.from(cborHex, 'hex')),
        contentType: 'application/cbor',
      })
      return { txHash: koios.parseWith(txHash, data, '/submittx') }
    },

    async getTxStatus(hash: string): Promise<TxStatus> {
      const data = await koios.postJson('/tx_status', { _tx_hashes: [hash] })
      const rows = koios.parseWith(z.array(txStatusRow), data, '/tx_status')
      const confirmations = rows[0]?.num_confirmations ?? null
      return { seen: confirmations !== null, confirmations: confirmations ?? 0 }
    },
  }
}
