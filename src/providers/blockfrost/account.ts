import { z } from 'zod'
import { ProviderError } from '../../domain/errors.js'
import type { AccountReward, AccountState, RewardKind } from '../../domain/types/account.js'
import type { Utxo, WalletTransaction } from '../../domain/types/transactions.js'
import type { AccountCapability } from '../capabilities/account.js'
import type { BlockfrostClient } from './client.js'
import { resolveBlockHeights } from './blocks.js'
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
  // Creation block, as a hash. Blockfrost puts no height on the row, so this is the only route to
  // the creation provenance the contract promises; resolved through blocks.ts per distinct block.
  block: z.string(),
  data_hash: z.string().nullish(),
  inline_datum: z.string().nullish(),
  reference_script_hash: z.string().nullish(),
})

type AccountUtxoRow = z.infer<typeof accountUtxoRow>

function mapUtxo(
  row: AccountUtxoRow,
  seenUnits: Map<string, string>,
  blockHeights: ReadonlyMap<string, number>,
): Utxo {
  const { value, assets } = splitAmount(row.amount, seenUnits)
  const blockHeight = blockHeights.get(row.block)
  if (blockHeight === undefined) {
    // Unreachable while the heights are resolved from these same rows. It throws rather than
    // substituting anything: a fabricated creation height would be persisted by the client as
    // though we had authority for it. The message names no output reference, which would
    // identify the wallet.
    throw new ProviderError(
      'blockfrost account utxo references a block whose height was not resolved',
    )
  }
  return {
    txHash: row.tx_hash,
    outputIndex: row.output_index,
    address: row.address,
    blockHeight,
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
      let previous = await scanAccountUtxos(client, path)
      const seenUnits = new Map<string, string>()
      // Resolved only once a scan has settled, so the extra block lookups are never spent on a
      // page walk that is about to be discarded and repeated.
      const settle = async (rows: AccountUtxoRow[]): Promise<Utxo[]> => {
        const blockHeights = await resolveBlockHeights(
          client,
          rows.map((row) => row.block),
        )
        return rows.map((row) => mapUtxo(row, seenUnits, blockHeights))
      }
      if (!previous.needsVerification && !previous.hasDuplicate) {
        return settle(previous.rows)
      }

      for (let scan = 2; scan <= UTXO_CONSISTENCY_SCANS; scan += 1) {
        const current = await scanAccountUtxos(client, path)
        if (
          !previous.hasDuplicate &&
          !current.hasDuplicate &&
          sameKeys(previous.keys, current.keys)
        ) {
          return settle(current.rows)
        }
        previous = current
      }

      // Never include the stake address or output references: both identify the wallet.
      throw new ProviderError('blockfrost account utxos changed during paged read; retry')
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
