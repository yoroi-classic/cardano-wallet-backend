import { z } from 'zod'
import { ProviderError } from '../../domain/errors.js'
import type { AccountReward, AccountState } from '../../domain/types/account.js'
import type { Utxo, WalletTransaction } from '../../domain/types/transactions.js'
import type { AccountCapability } from '../capabilities/account.js'
import type { BlockfrostClient } from './client.js'
import { notImplemented } from './not-implemented.js'
import { amountList, numeric, splitAmount } from './schema.js'

/** `account_content` (Blockfrost OpenAPI spec, `/accounts/{stake_address}`). */
const accountRow = z.object({
  stake_address: z.string(),
  registered: z.boolean(),
  controlled_amount: numeric,
  rewards_sum: numeric,
  withdrawals_sum: numeric,
  withdrawable_amount: numeric,
  pool_id: z.string().nullish(),
  drep_id: z.string().nullish(),
})

/** One row of `account_utxo_content` (Blockfrost OpenAPI spec, `/accounts/{stake_address}/utxos`). */
const accountUtxoRow = z.object({
  address: z.string(),
  tx_hash: z.string(),
  // `output_index` is the current field; `tx_index` is documented deprecated and kept only for
  // backward compatibility, so it is not read here.
  output_index: z.number().int().nonnegative(),
  amount: amountList,
  data_hash: z.string().nullish(),
  inline_datum: z.string().nullish(),
  reference_script_hash: z.string().nullish(),
})

function mapUtxo(row: z.infer<typeof accountUtxoRow>): Utxo {
  const { value, assets } = splitAmount(row.amount)
  return {
    txHash: row.tx_hash,
    outputIndex: row.output_index,
    address: row.address,
    value,
    assets,
    datumHash: row.data_hash ?? undefined,
    inlineDatum: row.inline_datum ?? undefined,
    referenceScriptHash: row.reference_script_hash ?? undefined,
  }
}

// Blockfrost's own documented maximum per page.
const UTXO_PAGE_SIZE = 100
// 5,000 UTxOs is far above any realistic wallet; keeps the walk bounded if a page ever stops
// shrinking, the same defensive bound the Koios driver uses for its own unbounded lists.
const UTXO_MAX_PAGES = 50

export function createAccountMethods(client: BlockfrostClient): AccountCapability {
  return {
    async getAccountState(stakeAddress: string): Promise<AccountState> {
      const row = await client.getOrUndefined(
        accountRow,
        `/accounts/${encodeURIComponent(stakeAddress)}`,
      )
      // A stake key never seen on chain answers 404. Report it as an unregistered, zero-balance
      // account rather than an error, the same normalization the Koios driver applies to its own
      // "no row" case.
      if (row === undefined) {
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
        registered: row.registered,
        balance: String(row.controlled_amount),
        rewardsAvailable: String(row.withdrawable_amount),
        rewardsSum: String(row.rewards_sum),
        withdrawalsSum: String(row.withdrawals_sum),
        delegatedPool: row.pool_id ?? undefined,
        delegatedDrep: row.drep_id ?? undefined,
      }
    },

    async getAccountUtxos(stakeAddress: string): Promise<Utxo[]> {
      const path = `/accounts/${encodeURIComponent(stakeAddress)}/utxos`
      const rows: z.infer<typeof accountUtxoRow>[] = []

      for (let page = 1; page <= UTXO_MAX_PAGES; page += 1) {
        const pageRows = await client.getOrUndefined(
          z.array(accountUtxoRow),
          `${path}?count=${UTXO_PAGE_SIZE}&page=${page}`,
        )
        // A 404 here means the account has never been seen on chain, so it controls no UTxOs.
        // Legitimate, not an error, and it can only happen on page 1.
        if (pageRows === undefined) return []
        rows.push(...pageRows)
        if (pageRows.length < UTXO_PAGE_SIZE) return rows.map(mapUtxo)
      }

      // The cap ran out on a full page, which does not by itself mean anything was missed. Ask
      // for one more page to tell "ended exactly on the boundary" apart from "genuinely
      // truncated", the same technique the Koios driver uses for its own unbounded lists. The
      // probe has to keep the same page size: pagination is offset-based (offset = (page-1) *
      // count), so page 51 only lands on offset 5000 at count=100. Shrinking count to 1 would
      // probe offset 50 instead and reject any account with more than 50 UTxOs.
      const probe = await client.getOrUndefined(
        z.array(accountUtxoRow),
        `${path}?count=${UTXO_PAGE_SIZE}&page=${UTXO_MAX_PAGES + 1}`,
      )
      if (probe === undefined || probe.length === 0) return rows.map(mapUtxo)
      throw new ProviderError(
        `blockfrost account utxos exceed this provider's ${UTXO_MAX_PAGES * UTXO_PAGE_SIZE}-utxo scan bound`,
      )
    },

    // async so notImplemented()'s synchronous throw becomes a rejected promise rather than
    // escaping the call before a caller's `await` sees it. See the note in assets.ts.
    async getTxHistory(_stakeAddress: string, _afterBlock?: number): Promise<WalletTransaction[]> {
      // Koios answers a whole account's transaction history from one `/account_txs` call plus a
      // batched `/tx_info` hydration. Blockfrost has no equivalent combined endpoint: hydrating
      // one transaction means separate round trips for its UTxOs, withdrawals, and certificates
      // (`/txs/{hash}/utxos`, `/txs/{hash}/withdrawals`, `/txs/{hash}/delegations`, and so on), so
      // parity here is a meaningfully larger unit of work than the six-endpoint proof of
      // viability this PR ships. Left for a follow-up; see issue #4's status comment.
      return notImplemented('getTxHistory')
    },

    async getRewardHistory(_stakeAddress: string, _afterEpoch?: number): Promise<AccountReward[]> {
      // Blockfrost's `/accounts/{stake_address}/rewards` maps onto this fairly directly, unlike
      // the transaction history above, but it is still outside the seven endpoints this PR
      // targets. Straightforward pick for a follow-up.
      return notImplemented('getRewardHistory')
    },
  }
}
