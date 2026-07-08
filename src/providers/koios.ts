import { z } from 'zod'
import type { AccountState, ProtocolParams, Tip, TxStatus, Utxo } from '../domain/types.js'
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
  status: z.string(),
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

    async submitTx(cborHex: string): Promise<{ txHash: string }> {
      if (!/^[0-9a-fA-F]+$/.test(cborHex) || cborHex.length % 2 !== 0) {
        throw new BadRequestError('transaction must be a hex-encoded CBOR string')
      }
      const data = await request('/submittx', {
        method: 'POST',
        body: Uint8Array.from(Buffer.from(cborHex, 'hex')),
        contentType: 'application/cbor',
      })
      const txHash = parseWith(z.string(), data, '/submittx')
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
