import { z } from 'zod'
import type {
  AccountState,
  CertificateKind,
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
const certRow = z.object({
  index: z.number(),
  type: z.string(),
  info: z.record(z.string(), z.unknown()).nullish(),
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
  const kind = CERT_KIND[c.type] ?? 'other'
  const info = c.info ?? undefined
  // For an unrecognized kind, keep the provider's raw type so nothing is lost.
  const details = kind === 'other' ? { providerType: c.type, ...(info ?? {}) } : info
  return {
    kind,
    index: c.index,
    details: details && Object.keys(details).length > 0 ? details : undefined,
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

    async getAccountState(stakeAddress: string): Promise<AccountState> {
      const data = await postJson('/account_info', { _stake_addresses: [stakeAddress] })
      const rows = parseWith(z.array(accountInfoRow), data, '/account_info')
      const row = rows[0]
      // An unknown or never-used stake key legitimately has no row. Report it as an
      // unregistered, zero-balance account rather than treating it as an error.
      if (!row) {
        return { stakeAddress, registered: false, balance: '0', rewardsAvailable: '0' }
      }
      return {
        stakeAddress: row.stake_address,
        registered: row.status === 'registered',
        balance: String(row.total_balance),
        rewardsAvailable: String(row.rewards_available),
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

      // One page, oldest first. The caller pages forward with the last block it saw.
      const page = [...list]
        .sort((a, b) => a.block_height - b.block_height)
        .slice(0, HISTORY_PAGE_SIZE)
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
