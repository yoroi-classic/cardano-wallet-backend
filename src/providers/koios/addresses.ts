import { z } from 'zod'
import { MalformedUpstreamError } from '../../domain/errors.js'
import type {
  CertificateKind,
  TxCertificate,
  TxIo,
  Utxo,
  WalletTransaction,
  Withdrawal,
} from '../../domain/types/transactions.js'
import type { AddressCapability } from '../capabilities/addresses.js'
import type { KoiosClient } from './client.js'
import { assetItem, mapAssets, numeric } from './schema.js'

// How many transactions we detail per page. Matches the stake-account history page (and the
// extension's request size).
const HISTORY_PAGE_SIZE = 50

const addressRow = z.object({ address: z.string() })

// Address-keyed sibling of koios/account.ts's accountUtxoRow. Kept as its own copy rather than
// shared: the two schemas answer different Koios RPCs (/address_utxos vs /account_utxos) that
// happen to overlap in shape today, and koios/tx.ts's utxoRow shows this project's own precedent
// for that (it duplicates the same shape again, for /utxo_info).
const addressUtxoRow = z.object({
  tx_hash: z.string(),
  tx_index: z.number(),
  address: z.string(),
  value: numeric,
  asset_list: z.array(assetItem).nullish(),
  datum_hash: z.string().nullish(),
  inline_datum: z.object({ bytes: z.string() }).nullish(),
  reference_script: z.object({ hash: z.string() }).nullish(),
})

function mapAddressUtxo(row: z.infer<typeof addressUtxoRow>): Utxo {
  return {
    txHash: row.tx_hash,
    outputIndex: row.tx_index,
    address: row.address,
    value: String(row.value),
    assets: mapAssets(row.asset_list),
    datumHash: row.datum_hash ?? undefined,
    inlineDatum: row.inline_datum?.bytes ?? undefined,
    referenceScriptHash: row.reference_script?.hash ?? undefined,
  }
}

// /address_txs is exactly as thin as /account_txs (verified against the Koios OpenAPI spec):
// tx_hash, block_height, block_time, epoch_no and nothing else, so the same list-then-hydrate
// pattern through /tx_info applies.
const addressTxRow = z.object({
  tx_hash: z.string(),
  block_height: z.number(),
  block_time: z.number(),
  epoch_no: z.number(),
})

// Lenient on the address: history should not 502 on an exotic (e.g. Byron) input or output.
const txIoRow = z.object({
  payment_addr: z.object({ bech32: z.string() }).nullish(),
  value: numeric,
  asset_list: z.array(assetItem).nullish(),
})

const withdrawalRow = z.object({ stake_addr: z.string(), amount: numeric })
const certRow = z.object({ index: z.number(), type: z.string() })

// Koios certificate type -> our normalized kind. Unrecognized types fall to 'other'.
const CERT_KIND: Record<string, CertificateKind> = {
  stake_registration: 'stake_registration',
  stake_deregistration: 'stake_deregistration',
  delegation: 'stake_delegation',
  pool_update: 'pool_registration',
  pool_retire: 'pool_retirement',
  vote_delegation: 'vote_delegation',
  drep_registration: 'drep_registration',
  drep_update: 'drep_update',
  drep_deregistration: 'drep_deregistration',
  committee_hot_auth: 'committee_hot_auth',
  committee_cold_resign: 'committee_cold_resign',
  treasury_MIR: 'move_instantaneous_rewards',
  reserve_MIR: 'move_instantaneous_rewards',
  genesis: 'genesis_key_delegation',
}

const txInfoRow = z.object({
  tx_hash: z.string(),
  block_hash: z.string(),
  block_height: z.number(),
  epoch_no: z.number(),
  absolute_slot: z.number(),
  tx_timestamp: z.number(),
  tx_block_index: z.number(),
  fee: numeric,
  invalid_after: numeric.nullish(),
  inputs: z.array(txIoRow).nullish(),
  outputs: z.array(txIoRow).nullish(),
  withdrawals: z.array(withdrawalRow).nullish(),
  certificates: z.array(certRow).nullish(),
  metadata: z.unknown().nullish(),
})

function mapCertificate(c: z.infer<typeof certRow>): TxCertificate {
  return { kind: CERT_KIND[c.type] ?? 'other', index: c.index }
}

function mapTxIo(row: z.infer<typeof txIoRow>): TxIo {
  return {
    address: row.payment_addr?.bech32 ?? undefined,
    value: String(row.value),
    assets: mapAssets(row.asset_list),
  }
}

function mapTx(row: z.infer<typeof txInfoRow>): WalletTransaction {
  const withdrawals: Withdrawal[] = (row.withdrawals ?? []).map((w) => ({
    stakeAddress: w.stake_addr,
    amount: String(w.amount),
  }))
  const certificates: TxCertificate[] = (row.certificates ?? []).map(mapCertificate)
  return {
    txHash: row.tx_hash,
    block: row.block_height,
    blockHash: row.block_hash,
    slot: row.absolute_slot,
    epoch: row.epoch_no,
    blockTime: row.tx_timestamp,
    fee: String(row.fee),
    ttl: row.invalid_after != null ? Number(row.invalid_after) : undefined,
    inputs: (row.inputs ?? []).map(mapTxIo),
    outputs: (row.outputs ?? []).map(mapTxIo),
    withdrawals,
    certificates,
    metadata: row.metadata ?? undefined,
  }
}

/**
 * Hydrate a page of thin tx rows (already sorted oldest first, already cut at a block
 * boundary) through /tx_info, and verify what comes back is exactly what was asked for.
 *
 * Mirrors koios/account.ts's getTxHistory exactly: a missing transaction is a permanent hole,
 * because the caller pages forward from the last block of this page and would step over it and
 * never ask again; an extra or duplicated one is worse, since it would attribute a payment to an
 * address it does not belong to, or show one twice. Failing loudly here costs a retry; any of
 * these silently costs the truth.
 */
async function hydrateTxHistory(
  koios: KoiosClient,
  hashes: string[],
): Promise<WalletTransaction[]> {
  const rows = await koios.batchAll(txInfoRow, '/tx_info', hashes, (chunk) => ({
    _tx_hashes: chunk,
    _inputs: true,
    _metadata: true,
    _assets: true,
    _withdrawals: true,
    _certs: true,
  }))

  const requested = new Set(hashes)
  const seen = new Set<string>()
  for (const row of rows) {
    if (!requested.has(row.tx_hash)) {
      throw new MalformedUpstreamError('koios /tx_info returned an unrequested transaction')
    }
    if (seen.has(row.tx_hash)) {
      throw new MalformedUpstreamError('koios /tx_info returned a duplicate transaction')
    }
    seen.add(row.tx_hash)
  }
  if (seen.size !== requested.size) {
    throw new MalformedUpstreamError(
      `koios /tx_info omitted ${requested.size - seen.size} of ${hashes.length} requested transactions`,
    )
  }

  return rows
    .sort((a, b) => a.block_height - b.block_height || a.tx_block_index - b.tx_block_index)
    .map(mapTx)
}

export function createAddressMethods(koios: KoiosClient): AddressCapability {
  return {
    async filterUsedAddresses(addresses: string[]): Promise<string[]> {
      if (addresses.length === 0) return []
      // Koios address_info returns a row only for addresses seen on chain, so the ones
      // that come back are the used set. Preserve the caller's order.
      const rows = await koios.batch(z.array(addressRow), '/address_info', {
        _addresses: addresses,
      })
      const used = new Set(rows.map((r) => r.address))
      return addresses.filter((a) => used.has(a))
    },

    async getUtxosByAddresses(addresses: string[]): Promise<Utxo[]> {
      if (addresses.length === 0) return []
      // Packed against the real body budget rather than sent as one request: a caller can send
      // up to the route's own cap, and that easily exceeds what one Koios request body allows.
      const rows = await koios.batchAll(addressUtxoRow, '/address_utxos', addresses, (chunk) => ({
        _addresses: chunk,
        _extended: true,
      }))
      return rows.map(mapAddressUtxo)
    },

    async getTxHistoryByAddresses(
      addresses: string[],
      afterBlock?: number,
    ): Promise<WalletTransaction[]> {
      if (addresses.length === 0) return []

      const rows = await koios.batchAll(addressTxRow, '/address_txs', addresses, (chunk) => ({
        _addresses: chunk,
        ...(afterBlock === undefined ? {} : { _after_block_height: afterBlock }),
      }))
      if (rows.length === 0) return []

      // A transaction touching more than one of the requested addresses (a self-transfer within
      // the same wallet, most commonly) comes back once per matching address, since Koios
      // answers per address and the set is batched independently. Collapse to one row per
      // tx_hash before paging, or the same transaction would occupy more than one slot in the
      // page and /tx_info would see it requested twice.
      const byHash = new Map<string, z.infer<typeof addressTxRow>>()
      for (const row of rows) byHash.set(row.tx_hash, row)
      const distinct = [...byHash.values()]

      // One page, oldest first. Don't cut through a block: include any trailing txs that share
      // the boundary block, so the next `after={block}` cursor can't skip the rest of it.
      const sorted = distinct.sort((a, b) => a.block_height - b.block_height)
      let end = Math.min(HISTORY_PAGE_SIZE, sorted.length)
      const boundaryBlock = sorted[end - 1]?.block_height
      while (end < sorted.length && sorted[end]?.block_height === boundaryBlock) end += 1
      const hashes = sorted.slice(0, end).map((r) => r.tx_hash)

      return hydrateTxHistory(koios, hashes)
    },
  }
}
