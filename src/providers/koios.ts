import { z } from 'zod'
import type {
  AccountState,
  CertificateKind,
  PoolInfo,
  PoolListParams,
  PoolMetadata,
  ProtocolParams,
  Tip,
  TxCertificate,
  TxIo,
  TxStatus,
  Utxo,
  WalletTransaction,
  Withdrawal,
} from '../domain/types.js'
import {
  BadRequestError,
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../domain/errors.js'
import type { ChainProvider } from './provider.js'

/** A minimal fetch signature so tests can inject a fake without pulling in DOM types. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string | Uint8Array
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

export interface KoiosConfig {
  /** Network-specific Koios base URL, e.g. https://preprod.koios.rest/api/v1 */
  baseUrl: string
  /** Optional bearer token for higher rate limits. */
  token?: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Injectable fetch, defaults to the global. */
  fetchImpl?: FetchLike
}

/**
 * Koios returns lovelace-scale values as either numbers or numeric strings. Both
 * branches are constrained to non-negative integers so a malformed upstream value
 * (a negative, a float, a non-numeric string) fails validation and lands on the
 * MalformedUpstreamError path rather than propagating as junk.
 */
const numeric = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])

const tipRow = z.object({
  hash: z.string(),
  epoch_no: z.number(),
  abs_slot: z.number(),
  block_no: z.number(),
})

const epochParamsRow = z.object({
  epoch_no: z.number(),
  min_fee_a: z.number(),
  min_fee_b: z.number(),
  max_tx_size: z.number(),
  max_block_size: z.number(),
  key_deposit: numeric,
  pool_deposit: numeric,
  min_pool_cost: numeric,
  coins_per_utxo_size: numeric,
  max_val_size: z.number(),
  collateral_percent: z.number(),
  max_collateral_inputs: z.number(),
  price_mem: z.number(),
  price_step: z.number(),
  max_tx_ex_mem: numeric,
  max_tx_ex_steps: numeric,
  protocol_major: z.number(),
  protocol_minor: z.number(),
  cost_models: z.record(z.string(), z.unknown()).nullish(),
})

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
  asset_list: z
    .array(z.object({ policy_id: z.string(), asset_name: z.string(), quantity: numeric }))
    .nullish(),
  datum_hash: z.string().nullish(),
  inline_datum: z.object({ bytes: z.string() }).nullish(),
  reference_script: z.object({ hash: z.string() }).nullish(),
})

const txStatusRow = z.object({
  tx_hash: z.string(),
  num_confirmations: z.number().nullish(),
})

const accountTxRow = z.object({
  tx_hash: z.string(),
  block_height: z.number(),
  block_time: z.number(),
  epoch_no: z.number(),
})

const assetItem = z.object({
  policy_id: z.string(),
  asset_name: z.string(),
  quantity: numeric,
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

const poolMetaJson = z.object({
  name: z.string().nullish(),
  ticker: z.string().nullish(),
  homepage: z.string().nullish(),
  description: z.string().nullish(),
})

const poolInfoRow = z.object({
  pool_id_bech32: z.string(),
  pool_id_hex: z.string(),
  // Koios documents exactly these three; anything else is unexpected upstream data.
  pool_status: z.enum(['registered', 'retiring', 'retired']),
  retiring_epoch: z.number().nullish(),
  margin: z.number(),
  fixed_cost: numeric.nullish(),
  pledge: numeric.nullish(),
  live_pledge: numeric.nullish(),
  active_stake: numeric.nullish(),
  live_stake: numeric.nullish(),
  // Koios reports saturation as a percentage (e.g. 3.12 == 3.12%); normalize to a fraction.
  live_saturation: z.number().nullish(),
  live_delegators: z.number().nullish(),
  block_count: z.number().nullish(),
  meta_json: poolMetaJson.nullish(),
})

function mapPoolMetadata(
  m: z.infer<typeof poolMetaJson> | null | undefined,
): PoolMetadata | undefined {
  if (!m) return undefined
  const md: PoolMetadata = {}
  if (m.name != null) md.name = m.name
  if (m.ticker != null) md.ticker = m.ticker
  if (m.homepage != null) md.homepage = m.homepage
  if (m.description != null) md.description = m.description
  return Object.keys(md).length > 0 ? md : undefined
}

const poolStakeRow = z.object({
  pool_id_bech32: z.string(),
  active_stake: numeric.nullish(),
})

type PoolStakeRow = z.infer<typeof poolStakeRow>

// Koios rejects a /pool_info body carrying 100 ids with a 413, so hydrate in smaller
// batches. 50 leaves room for the id set to grow without brushing the limit again.
const POOL_INFO_CHUNK = 50
// Koios caps a single response at 1000 rows.
const POOL_LIST_PAGE_SIZE = 1000
// ~3k registered pools on mainnet today. 20 pages is far above that and keeps the walk
// bounded if upstream ever stops shrinking the last page.
const POOL_LIST_MAX_PAGES = 20

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

// Pools with no active stake sort last, so give them a value below every real stake.
const NO_ACTIVE_STAKE = -1n

function activeStakeOf(row: PoolStakeRow): bigint {
  return row.active_stake == null ? NO_ACTIVE_STAKE : BigInt(row.active_stake)
}

// Largest active stake first. Ties break on pool id so that the order is total and paging
// stays stable: without it, equally-staked pools could shuffle between calls and the same
// pool could be served twice, or skipped, across two pages.
function byActiveStakeDesc(a: PoolStakeRow, b: PoolStakeRow): number {
  const left = activeStakeOf(a)
  const right = activeStakeOf(b)
  if (left !== right) return left > right ? -1 : 1
  return a.pool_id_bech32 < b.pool_id_bech32 ? -1 : a.pool_id_bech32 > b.pool_id_bech32 ? 1 : 0
}

function mapPoolInfo(row: z.infer<typeof poolInfoRow>): PoolInfo {
  return {
    poolId: row.pool_id_bech32,
    poolIdHex: row.pool_id_hex,
    status: row.pool_status,
    retiringEpoch: row.retiring_epoch ?? undefined,
    margin: row.margin,
    fixedCost: String(row.fixed_cost ?? 0),
    pledge: String(row.pledge ?? 0),
    livePledge: String(row.live_pledge ?? 0),
    activeStake: String(row.active_stake ?? 0),
    liveStake: String(row.live_stake ?? 0),
    // Koios gives saturation as a percentage; expose it as a fraction (1.0 == saturated).
    saturation: (row.live_saturation ?? 0) / 100,
    liveDelegators: row.live_delegators ?? 0,
    blocksMinted: row.block_count ?? 0,
    metadata: mapPoolMetadata(row.meta_json),
  }
}

// How many transactions we detail per page. Matches the extension's request size.
const HISTORY_PAGE_SIZE = 50

interface KoiosRequestInit {
  method?: 'GET' | 'POST'
  body?: string | Uint8Array
  contentType?: string
}

export function createKoiosProvider(config: KoiosConfig): ChainProvider {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? 10_000
  const doFetch: FetchLike = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)

  async function request(path: string, init: KoiosRequestInit = {}): Promise<unknown> {
    const url = `${baseUrl}${path}`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (config.token) headers.authorization = `Bearer ${config.token}`
    if (init.contentType) headers['content-type'] = init.contentType

    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await doFetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ProviderTimeoutError(`koios request timed out: ${path}`, cause)
      }
      throw new ProviderError(`koios request failed: ${path}`, { cause })
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ProviderError(`koios returned ${res.status} for ${path}`, {
        upstreamStatus: res.status,
        cause: body.slice(0, 500),
      })
    }

    try {
      return await res.json()
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ProviderTimeoutError(`koios response timed out: ${path}`, cause)
      }
      throw new MalformedUpstreamError(`koios returned invalid json for ${path}`, cause)
    }
  }

  function postJson(path: string, body: unknown): Promise<unknown> {
    return request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      contentType: 'application/json',
    })
  }

  function parseWith<T>(schema: z.ZodType<T>, data: unknown, path: string): T {
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      throw new MalformedUpstreamError(
        `koios response shape mismatch for ${path}`,
        parsed.error.issues,
      )
    }
    return parsed.data
  }

  function parseFirst<T>(schema: z.ZodType<T>, data: unknown, path: string): T {
    const rows = parseWith(z.array(z.unknown()), data, path)
    if (rows.length === 0) {
      throw new MalformedUpstreamError(`koios returned no rows for ${path}`)
    }
    return parseWith(schema, rows[0], path)
  }

  function mapUtxo(row: z.infer<typeof accountUtxoRow>): Utxo {
    return {
      txHash: row.tx_hash,
      outputIndex: row.tx_index,
      address: row.address,
      value: String(row.value),
      assets: (row.asset_list ?? []).map((a) => ({
        policyId: a.policy_id,
        assetName: a.asset_name,
        quantity: String(a.quantity),
      })),
      datumHash: row.datum_hash ?? undefined,
      inlineDatum: row.inline_datum?.bytes ?? undefined,
      referenceScriptHash: row.reference_script?.hash ?? undefined,
    }
  }

  function mapTxIo(row: z.infer<typeof txIoRow>): TxIo {
    return {
      address: row.payment_addr?.bech32 ?? undefined,
      value: String(row.value),
      assets: (row.asset_list ?? []).map((a) => ({
        policyId: a.policy_id,
        assetName: a.asset_name,
        quantity: String(a.quantity),
      })),
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

  // Hydrate a set of pool ids with full pool_info, preserving the input order. Unknown ids
  // are simply absent from Koios, so the result is never longer than the input.
  //
  // Koios rejects an oversized request body with a 413, and a single batch of 100 ids is
  // already over that limit, so the ids are hydrated in chunks and stitched back together.
  async function poolInfoByIds(poolIds: string[]): Promise<PoolInfo[]> {
    if (poolIds.length === 0) return []
    const byId = new Map<string, z.infer<typeof poolInfoRow>>()
    for (const chunk of chunked(poolIds, POOL_INFO_CHUNK)) {
      const data = await postJson('/pool_info', { _pool_bech32_ids: chunk })
      const rows = parseWith(z.array(poolInfoRow), data, '/pool_info')
      for (const row of rows) byId.set(row.pool_id_bech32, row)
    }
    return poolIds.flatMap((id) => {
      const row = byId.get(id)
      return row ? [mapPoolInfo(row)] : []
    })
  }

  // Read every registered pool's id and active stake, following Koios's paging to the end.
  // The page cap bounds the walk so a misbehaving upstream cannot spin here forever.
  async function registeredPoolStakes(ticker?: string): Promise<PoolStakeRow[]> {
    const rows: PoolStakeRow[] = []
    for (let page = 0; page < POOL_LIST_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        pool_status: 'eq.registered',
        // active_stake is a text column upstream, so it is selected for the local sort
        // below rather than ordered on here.
        select: 'pool_id_bech32,active_stake',
        limit: String(POOL_LIST_PAGE_SIZE),
        offset: String(page * POOL_LIST_PAGE_SIZE),
      })
      if (ticker !== undefined) query.set('ticker', `ilike.*${ticker}*`)
      const data = await request(`/pool_list?${query.toString()}`)
      const parsed = parseWith(z.array(poolStakeRow), data, '/pool_list')
      rows.push(...parsed)
      if (parsed.length < POOL_LIST_PAGE_SIZE) return rows
    }
    return rows
  }

  return {
    name: 'koios',

    async getTip(): Promise<Tip> {
      const data = await request('/tip')
      const row = parseFirst(tipRow, data, '/tip')
      return { block: row.block_no, slot: row.abs_slot, epoch: row.epoch_no, hash: row.hash }
    },

    async getProtocolParams(): Promise<ProtocolParams> {
      const data = await request('/epoch_params?order=epoch_no.desc&limit=1')
      const row = parseFirst(epochParamsRow, data, '/epoch_params')
      return {
        epoch: row.epoch_no,
        minFeeA: row.min_fee_a,
        minFeeB: row.min_fee_b,
        maxTxSize: row.max_tx_size,
        maxBlockBodySize: row.max_block_size,
        keyDeposit: String(row.key_deposit),
        poolDeposit: String(row.pool_deposit),
        minPoolCost: String(row.min_pool_cost),
        coinsPerUtxoByte: String(row.coins_per_utxo_size),
        maxValueSize: row.max_val_size,
        collateralPercent: row.collateral_percent,
        maxCollateralInputs: row.max_collateral_inputs,
        priceMem: row.price_mem,
        priceStep: row.price_step,
        maxTxExMem: String(row.max_tx_ex_mem),
        maxTxExSteps: String(row.max_tx_ex_steps),
        protocolVersion: { major: row.protocol_major, minor: row.protocol_minor },
        costModels: row.cost_models ?? {},
      }
    },

    async filterUsedAddresses(addresses: string[]): Promise<string[]> {
      if (addresses.length === 0) return []
      // Koios address_info returns a row only for addresses seen on chain, so the ones
      // that come back are the used set. Preserve the caller's order.
      const data = await postJson('/address_info', { _addresses: addresses })
      const rows = parseWith(z.array(z.object({ address: z.string() })), data, '/address_info')
      const used = new Set(rows.map((r) => r.address))
      return addresses.filter((a) => used.has(a))
    },

    async getAccountState(stakeAddress: string): Promise<AccountState> {
      const data = await postJson('/account_info', { _stake_addresses: [stakeAddress] })
      const rows = parseWith(z.array(accountInfoRow), data, '/account_info')
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
      const data = await postJson('/account_utxos', {
        _stake_addresses: [stakeAddress],
        _extended: true,
      })
      const rows = parseWith(z.array(accountUtxoRow), data, '/account_utxos')
      return rows.map(mapUtxo)
    },

    async getTxHistory(stakeAddress: string, afterBlock?: number): Promise<WalletTransaction[]> {
      // account_txs is the single-account form; use GET with query params.
      const query = new URLSearchParams({ _stake_address: stakeAddress })
      if (afterBlock !== undefined) query.set('_after_block_height', String(afterBlock))
      const listData = await request(`/account_txs?${query.toString()}`)
      const list = parseWith(z.array(accountTxRow), listData, '/account_txs')
      if (list.length === 0) return []

      // One page, oldest first. Don't cut through a block: include any trailing txs that
      // share the boundary block, so the next `after={block}` cursor can't skip the rest
      // of that block. The caller pages forward with the last block it saw.
      const sorted = [...list].sort((a, b) => a.block_height - b.block_height)
      let end = Math.min(HISTORY_PAGE_SIZE, sorted.length)
      const boundaryBlock = sorted[end - 1]?.block_height
      while (end < sorted.length && sorted[end]?.block_height === boundaryBlock) end += 1
      const page = sorted.slice(0, end)
      const data = await postJson('/tx_info', {
        _tx_hashes: page.map((r) => r.tx_hash),
        _inputs: true,
        _metadata: true,
        _assets: true,
        _withdrawals: true,
        _certs: true,
      })
      const rows = parseWith(z.array(txInfoRow), data, '/tx_info')
      return rows
        .sort((a, b) => a.block_height - b.block_height || a.tx_block_index - b.tx_block_index)
        .map(mapTx)
    },

    getPoolInfo(poolIds: string[]): Promise<PoolInfo[]> {
      return poolInfoByIds(poolIds)
    },

    async getPoolList({ limit, offset, ticker }: PoolListParams): Promise<PoolInfo[]> {
      // Neutral ordering: registered pools by active stake, largest first, no promotional
      // ranking.
      //
      // The sort has to happen here, not upstream. Koios stores active_stake as text, so
      // ordering on it in the query sorts lexicographically: a pool with 9_998_813_687
      // lovelace comes out above one with 7_682_048_683_977, because '9' > '7'. Ordering
      // by stake is this endpoint's contract, so read the whole registered set (id and
      // stake only, which is light), sort it numerically, and hydrate just the requested
      // page with full pool_info.
      const stakes = await registeredPoolStakes(ticker)
      const page = stakes.sort(byActiveStakeDesc).slice(offset, offset + limit)
      return poolInfoByIds(page.map((r) => r.pool_id_bech32))
    },

    async submitTx(cborHex: string): Promise<{ txHash: string }> {
      if (!/^[0-9a-fA-F]+$/.test(cborHex) || cborHex.length % 2 !== 0) {
        throw new BadRequestError('transaction must be a hex-encoded CBOR string')
      }
      const data = await request('/submittx', {
        method: 'POST',
        body: Uint8Array.from(Buffer.from(cborHex, 'hex')),
        contentType: 'application/cbor',
      })
      const txHash = parseWith(z.string().regex(/^[0-9a-fA-F]{64}$/), data, '/submittx')
      return { txHash }
    },

    async getTxStatus(txHash: string): Promise<TxStatus> {
      const data = await postJson('/tx_status', { _tx_hashes: [txHash] })
      const rows = parseWith(z.array(txStatusRow), data, '/tx_status')
      const confirmations = rows[0]?.num_confirmations ?? null
      return { seen: confirmations !== null, confirmations: confirmations ?? 0 }
    },
  }
}
