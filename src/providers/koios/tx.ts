import { z } from 'zod'
import { BadRequestError, MalformedUpstreamError } from '../../domain/errors.js'
import {
  confirmedTxStatus,
  unknownTxStatus,
  type ResolvedUtxo,
  type TxStatus,
} from '../../domain/types/transactions.js'
import type { TxCapability } from '../capabilities/tx.js'
import type { KoiosClient } from './client.js'
import { assetItem, mapAssets, numeric } from './schema.js'

const txStatusRow = z.object({
  tx_hash: z.string(),
  // A confirmation count is a number of blocks on top: a whole, non-negative one.
  num_confirmations: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
})

const txHashRow = z.string().regex(/^[0-9a-fA-F]{64}$/)

const utxoRow = z.object({
  tx_hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  tx_index: z.number().int().nonnegative(),
  address: z.string(),
  value: numeric,
  asset_list: z.array(assetItem).nullish(),
  datum_hash: z.string().nullish(),
  inline_datum: z.object({ bytes: z.string() }).nullish(),
  reference_script: z.object({ hash: z.string() }).nullish(),
  // Strict, and deliberately not defaulted. This is the field the whole endpoint exists for: a
  // wallet that offers a *spent* output as collateral builds a transaction the node rejects, and
  // the user sees a failure with no explanation. Reading a missing value as "unspent" would be
  // guessing, in the direction that breaks things.
  is_spent: z.boolean(),
})

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
      const normalizedHash = hash.toLowerCase()
      const rows = await koios.batch(z.array(txStatusRow), '/tx_status', {
        _tx_hashes: [normalizedHash],
      })

      // Match the row to the hash we asked about rather than trusting rows[0]. A
      // mismatched response would otherwise report another transaction's confirmations as
      // this one's, which for a wallet means telling someone a payment landed when it did
      // not. Hex case does not change transaction identity, so compare canonical spellings even
      // if a non-canonical upstream instance echoes uppercase. No rows at all is legitimate: the
      // transaction isn't on chain yet.
      const row = rows.find((r) => r.tx_hash.toLowerCase() === normalizedHash)
      if (rows.length > 0 && row === undefined) {
        throw new MalformedUpstreamError('koios returned tx_status rows for a different tx')
      }

      const confirmations = row?.num_confirmations ?? null
      // Koios indexes only on-chain transactions. A null is neither a mempool answer nor proof
      // of rejection/expiry, so it must remain unknown and keep the caller's overlay intact.
      return confirmations === null ? unknownTxStatus() : confirmedTxStatus(confirmations)
    },

    async getUtxosByRef(refs: string[]): Promise<ResolvedUtxo[]> {
      if (refs.length === 0) return []

      // Packed against Koios's real body limit rather than a guessed count. `_extended` is what
      // makes Koios return the asset list and the datum at all, and it is part of the body that
      // batchAll measures: without it, a dApp connector resolving an input would see a bare
      // lovelace value and none of the tokens actually sitting on the output.
      const rows = await koios.batchAll(utxoRow, '/utxo_info', refs, (chunk) => ({
        _utxo_refs: chunk,
        _extended: true,
      }))
      const byRef = new Map(rows.map((row) => [`${row.tx_hash}#${row.tx_index}`, row]))

      // The caller's order, and references that are not on chain are simply absent rather than
      // being an error: asking about an output that never existed, or has been rolled back, is a
      // legitimate question with the answer "nothing here".
      return refs.flatMap((ref) => {
        const row = byRef.get(ref.toLowerCase())
        if (row === undefined) return []
        return [
          {
            txHash: row.tx_hash,
            outputIndex: row.tx_index,
            address: row.address,
            value: String(row.value),
            assets: mapAssets(row.asset_list),
            datumHash: row.datum_hash ?? undefined,
            inlineDatum: row.inline_datum?.bytes ?? undefined,
            referenceScriptHash: row.reference_script?.hash ?? undefined,
            spent: row.is_spent,
          },
        ]
      })
    },
  }
}
