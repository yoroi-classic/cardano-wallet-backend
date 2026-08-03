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

type AccountUtxoRow = z.infer<typeof accountUtxoRow>

function mapUtxo(row: AccountUtxoRow): Utxo {
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
// Blockfrost exposes offset pages but no snapshot token for this endpoint. Require two
// consecutive complete walks to agree, with one extra walk available after observed churn.
const UTXO_CONSISTENCY_SCANS = 3

interface UtxoScan {
  rows: AccountUtxoRow[]
  keys: string[]
  needsVerification: boolean
  hasDuplicate: boolean
}

const utxoKey = (row: AccountUtxoRow): string => `${row.tx_hash}#${row.output_index}`

function sameKeys(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

async function scanAccountUtxos(client: BlockfrostClient, path: string): Promise<UtxoScan> {
  const rows: AccountUtxoRow[] = []
  const keys: string[] = []
  const seen = new Set<string>()
  let hasDuplicate = false

  const append = (pageRows: AccountUtxoRow[]): void => {
    for (const row of pageRows) {
      const key = utxoKey(row)
      if (seen.has(key)) hasDuplicate = true
      seen.add(key)
      keys.push(key)
      rows.push(row)
    }
  }

  for (let page = 1; page <= UTXO_MAX_PAGES; page += 1) {
    const pageRows = await client.getOrUndefined(
      z.array(accountUtxoRow),
      `${path}?count=${UTXO_PAGE_SIZE}&page=${page}&order=asc`,
    )
    // A never-seen account answers 404 on page one. A later 404 cannot describe a complete
    // walk after earlier rows and must fail closed with the other consistency failures.
    if (pageRows === undefined) {
      if (page === 1) return { rows: [], keys: [], needsVerification: false, hasDuplicate: false }
      throw new ProviderError('blockfrost account utxos changed during paged read; retry')
    }
    append(pageRows)
    if (pageRows.length < UTXO_PAGE_SIZE) {
      return { rows, keys, needsVerification: page > 1, hasDuplicate }
    }
  }

  // The cap ran out on a full page, which does not by itself mean anything was missed. Ask
  // for one more page to tell "ended exactly on the boundary" apart from "genuinely
  // truncated". The probe must keep count=100 because Blockfrost pagination is offset-based.
  const probe = await client.getOrUndefined(
    z.array(accountUtxoRow),
    `${path}?count=${UTXO_PAGE_SIZE}&page=${UTXO_MAX_PAGES + 1}&order=asc`,
  )
  if (probe === undefined || probe.length === 0) {
    return { rows, keys, needsVerification: true, hasDuplicate }
  }
  throw new ProviderError(
    `blockfrost account utxos exceed this provider's ${UTXO_MAX_PAGES * UTXO_PAGE_SIZE}-utxo scan bound`,
  )
}

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
      let previous = await scanAccountUtxos(client, path)
      if (!previous.needsVerification && !previous.hasDuplicate) return previous.rows.map(mapUtxo)

      for (let scan = 2; scan <= UTXO_CONSISTENCY_SCANS; scan += 1) {
        const current = await scanAccountUtxos(client, path)
        if (
          !previous.hasDuplicate &&
          !current.hasDuplicate &&
          sameKeys(previous.keys, current.keys)
        ) {
          return current.rows.map(mapUtxo)
        }
        previous = current
      }

      // Never include the stake address or output references: both identify the wallet.
      throw new ProviderError('blockfrost account utxos changed during paged read; retry')
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
