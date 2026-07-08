import { z } from 'zod'
import type { ProtocolParams, Tip } from '../domain/types.js'
import { MalformedUpstreamError, ProviderError, ProviderTimeoutError } from '../domain/errors.js'
import type { ChainProvider } from './provider.js'

/** A minimal fetch signature so tests can inject a fake without pulling in DOM types. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
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
 * Koios returns lovelace-scale values as either numbers or numeric strings. The string
 * branch is constrained to digits so a malformed upstream value fails validation and
 * lands on the MalformedUpstreamError path rather than propagating as junk.
 */
const numeric = z.union([z.number(), z.string().regex(/^\d+$/)])

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

export function createKoiosProvider(config: KoiosConfig): ChainProvider {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? 10_000
  const doFetch: FetchLike = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)

  async function request(path: string): Promise<unknown> {
    const url = `${baseUrl}${path}`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (config.token) headers.authorization = `Bearer ${config.token}`

    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await doFetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
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

  function parseFirst<T>(schema: z.ZodType<T>, data: unknown, path: string): T {
    const rows = z.array(z.unknown()).safeParse(data)
    if (!rows.success) {
      throw new MalformedUpstreamError(`koios returned non-array data for ${path}`)
    }
    if (rows.data.length === 0) {
      throw new MalformedUpstreamError(`koios returned no rows for ${path}`)
    }
    const parsed = schema.safeParse(rows.data[0])
    if (!parsed.success) {
      throw new MalformedUpstreamError(
        `koios response shape mismatch for ${path}`,
        parsed.error.issues,
      )
    }
    return parsed.data
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
  }
}
