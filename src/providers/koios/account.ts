import { z } from 'zod'
import { MalformedUpstreamError } from '../../domain/errors.js'
import { REWARD_KINDS, type AccountReward, type AccountState } from '../../domain/types/account.js'
import type {
  CertificateKind,
  TxCertificate,
  TxIo,
  Utxo,
  WalletTransaction,
  Withdrawal,
} from '../../domain/types/transactions.js'
import type { AccountCapability } from '../capabilities/account.js'
import type { KoiosClient } from './client.js'
import { assetItem, chunked, mapAssets, numeric } from './schema.js'

// How many transactions we detail per page. Matches the extension's request size.
const HISTORY_PAGE_SIZE = 50
// Koios 413s on an oversized request body, and the boundary extension below can push a
// page well past HISTORY_PAGE_SIZE, so /tx_info is asked in batches this size.
const TX_INFO_CHUNK = 50

const accountInfoRow = z.object({
  stake_address: z.string(),
  // Koios documents exactly these two values; anything else is unexpected upstream data
  // and should follow the malformed path rather than silently read as unregistered.
  status: z.enum(['registered', 'not registered']),
  delegated_pool: z.string().nullish(),
  delegated_drep: z.string().nullish(),
  total_balance: numeric,
  rewards_available: numeric,
  rewards: numeric,
  withdrawals: numeric,
})

const accountUtxoRow = z.object({
  tx_hash: z.string(),
  tx_index: z.number(),
  address: z.string(),
  value: numeric,
  asset_list: z.array(assetItem).nullish(),
  datum_hash: z.string().nullish(),
  inline_datum: z.object({ bytes: z.string() }).nullish(),
  reference_script: z.object({ hash: z.string() }).nullish(),
})

// One reward, as Koios spells it. `type` is constrained to the set Koios documents rather than
// passed through, so an unexpected value is malformed upstream data and not a new reward kind
// silently leaking into our public contract.
const rewardRow = z.object({
  earned_epoch: z.number().int().nonnegative(),
  spendable_epoch: z.number().int().nonnegative(),
  amount: numeric,
  type: z.enum(REWARD_KINDS),
  // Absent for treasury, reserves and refunds, which are not paid by a pool.
  pool_id: z.string().nullish(),
})

// /account_rewards answers one object per stake address, each carrying its own reward list.
const accountRewardsRow = z.object({
  stake_address: z.string(),
  rewards: z.array(rewardRow).nullish(),
})

const accountTxRow = z.object({
  tx_hash: z.string(),
  block_height: z.number(),
  block_time: z.number(),
  epoch_no: z.number(),
})

// Lenient on the address: display history should not 502 on an exotic (e.g. Byron) output.
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

function mapUtxo(row: z.infer<typeof accountUtxoRow>): Utxo {
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

export function createAccountMethods(koios: KoiosClient): AccountCapability {
  return {
    async getAccountState(stakeAddress: string): Promise<AccountState> {
      const rows = await koios.batch(z.array(accountInfoRow), '/account_info', {
        _stake_addresses: [stakeAddress],
      })
      const row = rows[0]
      // An unknown or never-used stake key legitimately has no row. Report it as an
      // unregistered, zero-balance account rather than treating it as an error.
      if (!row) {
        return {
          stakeAddress,
          registered: false,
          balance: '0',
          rewardsAvailable: '0',
          rewardsSum: '0',
          withdrawalsSum: '0',
        }
      }
      return {
        stakeAddress: row.stake_address,
        registered: row.status === 'registered',
        balance: String(row.total_balance),
        rewardsAvailable: String(row.rewards_available),
        rewardsSum: String(row.rewards),
        withdrawalsSum: String(row.withdrawals),
        delegatedPool: row.delegated_pool ?? undefined,
        delegatedDrep: row.delegated_drep ?? undefined,
      }
    },

    async getAccountUtxos(stakeAddress: string): Promise<Utxo[]> {
      const rows = await koios.batch(z.array(accountUtxoRow), '/account_utxos', {
        _stake_addresses: [stakeAddress],
        _extended: true,
      })
      return rows.map(mapUtxo)
    },

    async getTxHistory(stakeAddress: string, afterBlock?: number): Promise<WalletTransaction[]> {
      // account_txs is the single-account form; use GET with query params.
      const query = new URLSearchParams({ _stake_address: stakeAddress })
      if (afterBlock !== undefined) query.set('_after_block_height', String(afterBlock))
      const list = await koios.get(z.array(accountTxRow), `/account_txs?${query.toString()}`)
      if (list.length === 0) return []

      // One page, oldest first. Don't cut through a block: include any trailing txs that
      // share the boundary block, so the next `after={block}` cursor can't skip the rest
      // of that block. The caller pages forward with the last block it saw.
      const sorted = [...list].sort((a, b) => a.block_height - b.block_height)
      let end = Math.min(HISTORY_PAGE_SIZE, sorted.length)
      const boundaryBlock = sorted[end - 1]?.block_height
      while (end < sorted.length && sorted[end]?.block_height === boundaryBlock) end += 1
      const hashes = sorted.slice(0, end).map((r) => r.tx_hash)

      // Hydrate in batches. A block holding many of this account's transactions can push
      // the page past HISTORY_PAGE_SIZE via the boundary extension above, and a single
      // oversized _tx_hashes body is what Koios answers with a 413.
      const rows: z.infer<typeof txInfoRow>[] = []
      for (const chunk of chunked(hashes, TX_INFO_CHUNK)) {
        const batch = await koios.batch(z.array(txInfoRow), '/tx_info', {
          _tx_hashes: chunk,
          _inputs: true,
          _metadata: true,
          _assets: true,
          _withdrawals: true,
          _certs: true,
        })
        rows.push(...batch)
      }

      // What comes back must be exactly what we asked for, no more and no less.
      //
      // A missing transaction is a permanent hole: the caller pages forward from the last
      // block of this page, so an omitted one is stepped over and never requested again.
      // An *extra* one is worse, because it would put a transaction that has nothing to do
      // with this account into the account's history. A duplicate would show a payment
      // twice. Failing loudly costs a retry; any of these silently costs the truth.
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
    },

    async getRewardHistory(stakeAddress: string, afterEpoch?: number): Promise<AccountReward[]> {
      const rows = await koios.batch(z.array(accountRewardsRow), '/account_rewards', {
        _stake_addresses: [stakeAddress],
      })

      // Exactly one account was asked about, so at most one row comes back. An account that has
      // never earned a reward is absent entirely, or present with a null list, and both mean the
      // same thing: no rewards. Neither is an error.
      const rewards = rows.find((row) => row.stake_address === stakeAddress)?.rewards ?? []

      return (
        rewards
          // Paged on the epoch the reward was *earned* for, which is the axis a graph plots
          // against. Paging on the spendable epoch would silently shift every point by two
          // epochs, which is ten days, and look entirely plausible.
          .filter((row) => afterEpoch === undefined || row.earned_epoch > afterEpoch)
          // Oldest first, as the transaction history is. Koios does not promise an order here,
          // and a graph drawn from an unordered series is a scribble.
          .sort((a, b) => a.earned_epoch - b.earned_epoch)
          .map((row) => ({
            earnedEpoch: row.earned_epoch,
            spendableEpoch: row.spendable_epoch,
            amount: String(row.amount),
            kind: row.type,
            // Treasury, reserves and refunds have no pool. Emitting an empty string would put a
            // pool id that does not exist into the response.
            ...(row.pool_id == null ? {} : { poolId: row.pool_id }),
          }))
      )
    },
  }
}
