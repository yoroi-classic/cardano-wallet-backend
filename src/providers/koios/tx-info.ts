import { z } from 'zod'
import { MalformedUpstreamError } from '../../domain/errors.js'
import type {
  CertificateKind,
  TxCertificate,
  TxIo,
  WalletTransaction,
  Withdrawal,
} from '../../domain/types/transactions.js'
import type { KoiosClient } from './client.js'
import { assetItem, mapAssets, numeric } from './schema.js'

/**
 * The /tx_info read shared by both history paths.
 *
 * A stake-keyed history (koios/account.ts) and an address-keyed history (koios/addresses.ts) list
 * thin transaction rows from different Koios endpoints, then hydrate the identical way: detail the
 * chosen hashes through /tx_info and verify what comes back is exactly what was asked for. That
 * verification is the correctness-critical part, so it lives here once rather than being copied
 * per caller and drifting.
 */

// Lenient on the address: history should not 502 on an exotic (e.g. Byron) input or output.
const txIoRow = z.object({
  payment_addr: z.object({ bech32: z.string() }).nullish(),
  value: numeric,
  asset_list: z.array(assetItem).nullish(),
})

const withdrawalRow = z.object({ stake_addr: z.string(), amount: numeric })
const certRow = z.object({ index: z.number(), type: z.string() })

const MAX_SAFE_TTL = BigInt(Number.MAX_SAFE_INTEGER)
const invalidAfter = z
  .union([z.number().int().nonnegative(), z.string().regex(/^(?:0|[1-9]\d*)$/)])
  .transform((value) => {
    // Koios exposes this ledger Word64 as a decimal string. Keep accepting every
    // canonical Word64-shaped value, but omit values that cannot be represented by
    // the public number-based transaction contract instead of rejecting the row.
    if (typeof value === 'string' && BigInt(value) > MAX_SAFE_TTL) return undefined
    return Number(value)
  })

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

export const txInfoRow = z.object({
  tx_hash: z.string(),
  block_hash: z.string(),
  block_height: z.number(),
  epoch_no: z.number(),
  absolute_slot: z.number(),
  tx_timestamp: z.number(),
  tx_block_index: z.number(),
  fee: numeric,
  invalid_after: invalidAfter.nullish(),
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

export function mapTx(row: z.infer<typeof txInfoRow>): WalletTransaction {
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
    ttl: row.invalid_after ?? undefined,
    inputs: (row.inputs ?? []).map(mapTxIo),
    outputs: (row.outputs ?? []).map(mapTxIo),
    withdrawals,
    certificates,
    metadata: row.metadata ?? undefined,
  }
}

/**
 * Hydrate a page of thin tx rows (already sorted oldest first, already cut at a block boundary)
 * through /tx_info, and verify what comes back is exactly what was asked for.
 *
 * What comes back must be exactly what we asked for, no more and no less. A missing transaction is
 * a permanent hole: the caller pages forward from the last block of this page, so an omitted one
 * is stepped over and never requested again. An extra one is worse, because it would attribute a
 * payment to a wallet it has nothing to do with; a duplicate would show one twice. Failing loudly
 * here costs a retry; any of these silently costs the truth.
 */
export async function hydrateTxHistory(
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
