import { z } from 'zod'
import { MalformedUpstreamError } from '../../domain/errors.js'
import { REWARD_KINDS, type AccountReward, type AccountState } from '../../domain/types/account.js'
import type { Utxo, WalletTransaction } from '../../domain/types/transactions.js'
import type { AccountCapability } from '../capabilities/account.js'
import type { KoiosClient } from './client.js'
import { assetItem, mapAssets, numeric } from './schema.js'
import { hydrateTxHistory } from './tx-info.js'

// How many transactions we detail per page. Matches the extension's request size.
const HISTORY_PAGE_SIZE = 50

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
  // Creation-block provenance (#110). Present on this RPC's rows, so it costs no extra call.
  // Strict: a UTxO with no creation height is malformed upstream data, and defaulting it would
  // put a fabricated provenance into a client's persisted store.
  block_height: z.number().int().nonnegative(),
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

function mapUtxo(row: z.infer<typeof accountUtxoRow>): Utxo {
  return {
    txHash: row.tx_hash,
    outputIndex: row.tx_index,
    address: row.address,
    blockHeight: row.block_height,
    value: String(row.value),
    assets: mapAssets(row.asset_list),
    datumHash: row.datum_hash ?? undefined,
    inlineDatum: row.inline_datum?.bytes ?? undefined,
    referenceScriptHash: row.reference_script?.hash ?? undefined,
  }
}

export function createAccountMethods(koios: KoiosClient): AccountCapability {
  return {
    async getAccountState(stakeAddress: string): Promise<AccountState> {
      // Bech32 permits an all-uppercase spelling, while Koios keys and returns addresses in their
      // canonical lowercase form. Query and compare that form so identity remains exact.
      const canonicalStakeAddress = stakeAddress.toLowerCase()
      const rows = await koios.batch(z.array(accountInfoRow), '/account_info', {
        _stake_addresses: [canonicalStakeAddress],
      })
      const row = rows[0]
      // An unknown or never-used stake key legitimately has no row. Report it as an
      // unregistered, zero-balance account rather than treating it as an error.
      if (!row) {
        return {
          stakeAddress: canonicalStakeAddress,
          registered: false,
          balance: '0',
          rewardsAvailable: '0',
          rewardsSum: '0',
          withdrawalsSum: '0',
        }
      }
      // Exactly one account was requested. Extra or mismatched rows mean the upstream answer
      // cannot safely be attributed to this wallet, even if the first row happens to match.
      if (rows.length !== 1 || row.stake_address !== canonicalStakeAddress) {
        throw new MalformedUpstreamError('koios returned invalid account_info row identity')
      }
      return {
        stakeAddress: canonicalStakeAddress,
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
      // Koios caps result sets at 1,000 rows. Use an explicit stable order and follow its
      // Content-Range metadata so a large wallet can never be returned as a plausible partial
      // state. The client retries the whole snapshot if an upstream page is inconsistent.
      const rows = await koios.batchAllPages(
        accountUtxoRow,
        '/account_utxos?order=tx_hash.asc,tx_index.asc',
        {
          _stake_addresses: [stakeAddress],
          _extended: true,
        },
        {
          rowKey: (row) => `${row.tx_hash}#${row.tx_index}`,
          verifyConsistency: true,
          keyset: (row) => [row.tx_hash, row.tx_index] as const,
        },
      )
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

      // Detail and verify the page through /tx_info. The boundary extension above can push it
      // past HISTORY_PAGE_SIZE, so the shared hydrate packs the _tx_hashes body against the byte
      // budget and enforces the missing/extra/duplicate guards in one place for both histories.
      return hydrateTxHistory(koios, hashes)
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
