import { z } from 'zod'
import { ProviderError } from '../../domain/errors.js'
import type { AccountReward, AccountState, RewardKind } from '../../domain/types/account.js'
import type { Utxo, WalletTransaction } from '../../domain/types/transactions.js'
import type { AccountCapability } from '../capabilities/account.js'
import type { BlockfrostClient } from './client.js'
import { amountList, numeric, splitAmount } from './schema.js'
import { addressSetTxHistory } from './tx-info.js'

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

// Page size for the paged account sub-resources (rewards, addresses); Blockfrost's own maximum.
const LIST_PAGE_SIZE = 100
// Defensive upper bounds on those walks, mirroring the utxo scan. A stake key with more reward
// epochs than any account has ever earned, or more addresses than any real wallet holds, is a
// runaway rather than a genuine account, and is surfaced loudly rather than returned as a partial.
const REWARD_MAX_PAGES = 100
const ADDRESS_MAX_PAGES = 100

// Blockfrost's `/accounts/{stake}/rewards` labels a reward `leader`, `member`, or
// `pool_deposit_refund`. The first two map straight onto our vocabulary; the deposit refund is our
// `refund` kind, which — like treasury and reserve payouts — is defined as having no paying pool, so
// its pool id is dropped below even though Blockfrost includes one. Treasury and reserve rewards are
// MIR payouts that Blockfrost surfaces on a separate `/mirs` resource without an earned epoch, so
// they do not appear here; that is the one reward-history parity gap versus Koios.
const rewardRow = z.object({
  epoch: z.number().int().nonnegative(),
  amount: numeric,
  pool_id: z.string(),
  type: z.enum(['leader', 'member', 'pool_deposit_refund']),
})

const REWARD_KIND: Record<z.infer<typeof rewardRow>['type'], RewardKind> = {
  leader: 'leader',
  member: 'member',
  pool_deposit_refund: 'refund',
}

const accountAddressRow = z.object({ address: z.string() })

/**
 * Every payment address the stake account has ever used, walked page by page. Blockfrost has no
 * account-level transaction feed, so a stake-keyed history is assembled by reading each of the
 * account's addresses; this is the enumeration that drives it. A never-seen stake key answers 404,
 * which means "no addresses", not an error.
 */
async function enumerateAccountAddresses(
  client: BlockfrostClient,
  stakeAddress: string,
): Promise<string[]> {
  const path = `/accounts/${encodeURIComponent(stakeAddress)}/addresses`
  const addresses: string[] = []

  for (let page = 1; page <= ADDRESS_MAX_PAGES; page += 1) {
    const pageRows = await client.getOrUndefined(
      z.array(accountAddressRow),
      `${path}?count=${LIST_PAGE_SIZE}&page=${page}`,
    )
    if (pageRows === undefined) return []
    for (const row of pageRows) addresses.push(row.address)
    if (pageRows.length < LIST_PAGE_SIZE) return addresses
  }

  // Same boundary probe the utxo scan uses: a full final page might mean the walk ended exactly on
  // the boundary or that it is genuinely truncated. Ask for one more page to tell the two apart.
  const probe = await client.getOrUndefined(
    z.array(accountAddressRow),
    `${path}?count=${LIST_PAGE_SIZE}&page=${ADDRESS_MAX_PAGES + 1}`,
  )
  if (probe === undefined || probe.length === 0) return addresses
  throw new ProviderError(
    `blockfrost account addresses exceed this provider's ${ADDRESS_MAX_PAGES * LIST_PAGE_SIZE}-address scan bound`,
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

    async getTxHistory(stakeAddress: string, afterBlock?: number): Promise<WalletTransaction[]> {
      // Blockfrost has no account-level transaction feed the way Koios's `/account_txs` is, so the
      // history is assembled from the account's own addresses: enumerate them, then read and
      // hydrate each one's transactions through the shared address-set walk, which dedups a
      // self-transfer touching several addresses and pages oldest-first on `afterBlock`.
      const addresses = await enumerateAccountAddresses(client, stakeAddress)
      return addressSetTxHistory(client, addresses, afterBlock)
    },

    async getRewardHistory(stakeAddress: string, afterEpoch?: number): Promise<AccountReward[]> {
      const path = `/accounts/${encodeURIComponent(stakeAddress)}/rewards`
      const rows: z.infer<typeof rewardRow>[] = []

      // Oldest first, page by page. A never-seen stake key answers 404 on page 1, meaning no
      // rewards rather than an error, the same normalization getAccountState applies.
      for (let page = 1; page <= REWARD_MAX_PAGES; page += 1) {
        const pageRows = await client.getOrUndefined(
          z.array(rewardRow),
          `${path}?count=${LIST_PAGE_SIZE}&page=${page}&order=asc`,
        )
        if (pageRows === undefined) return []
        rows.push(...pageRows)
        if (pageRows.length < LIST_PAGE_SIZE) break
        if (page === REWARD_MAX_PAGES) {
          const probe = await client.getOrUndefined(
            z.array(rewardRow),
            `${path}?count=${LIST_PAGE_SIZE}&page=${REWARD_MAX_PAGES + 1}&order=asc`,
          )
          if (probe !== undefined && probe.length > 0) {
            throw new ProviderError(
              `blockfrost account rewards exceed this provider's ${REWARD_MAX_PAGES * LIST_PAGE_SIZE}-reward scan bound`,
            )
          }
        }
      }

      return (
        rows
          // Paged on the epoch the reward was *earned* for — Blockfrost's `epoch` — which is the
          // axis a rewards graph plots against, matching how the Koios driver pages this read.
          .filter((row) => afterEpoch === undefined || row.epoch > afterEpoch)
          .sort((a, b) => a.epoch - b.epoch)
          .map((row) => {
            const kind = REWARD_KIND[row.type]
            return {
              earnedEpoch: row.epoch,
              // Rewards are paid two epochs in arrears on today's protocol; Blockfrost reports only
              // the earned epoch, so the spendable one is derived, the same value Koios returns.
              spendableEpoch: row.epoch + 2,
              amount: String(row.amount),
              kind,
              // A refund has no paying pool in our contract, so its pool id is dropped even though
              // Blockfrost supplies the refunded pool; member and leader rewards keep theirs.
              ...(kind === 'refund' ? {} : { poolId: row.pool_id }),
            }
          })
      )
    },
  }
}
