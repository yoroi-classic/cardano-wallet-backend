import { describe, expect, it, vi } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import {
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'

// Representative Blockfrost payloads, copied from the OpenAPI spec's own examples for
// `block_content` (/blocks/latest) and `epoch_param_content` (/epochs/latest/parameters).
const TIP_ROW = {
  time: 1_641_338_934,
  height: 15_243_593,
  hash: '4ea1ba291e8eef538635a53e59fddba7810d1679631cc3aed7c8e6c4091a516a',
  slot: 412_162_133,
  epoch: 425,
  epoch_slot: 12,
}

const EPOCH_PARAM_ROW = {
  epoch: 225,
  min_fee_a: 44,
  min_fee_b: 155_381,
  max_block_size: 65_536,
  max_tx_size: 16_384,
  max_block_header_size: 1100,
  key_deposit: '2000000',
  pool_deposit: '500000000',
  min_pool_cost: '340000000',
  coins_per_utxo_size: '34482',
  max_val_size: '5000',
  collateral_percent: 150,
  max_collateral_inputs: 3,
  price_mem: 0.0577,
  price_step: 0.0000721,
  max_tx_ex_mem: '10000000',
  max_tx_ex_steps: '10000000000',
  protocol_major_ver: 9,
  protocol_minor_ver: 0,
  cost_models_raw: {
    PlutusV1: [100_788, 420, 1],
    PlutusV2: [100_788, 420, 1, 1],
    PlutusV3: [100_788, 420, 1, 1, 1000],
  },
}

/** Build a fake fetch that returns one response and records the URL/headers it was called with. */
function fakeFetch(response: {
  ok?: boolean
  status?: number
  json?: () => Promise<unknown>
  text?: () => Promise<string>
  throws?: unknown
}): { fetchImpl: FetchLike; urls: string[]; headersSeen: Record<string, string>[] } {
  const urls: string[] = []
  const headersSeen: Record<string, string>[] = []
  const fetchImpl: FetchLike = vi.fn(async (url: string, init) => {
    urls.push(url)
    headersSeen.push(init?.headers ?? {})
    if (response.throws) throw response.throws
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: response.json ?? (async () => ({})),
      text: response.text ?? (async () => ''),
    }
  })
  return { fetchImpl, urls, headersSeen }
}

describe('blockfrost provider — happy path', () => {
  it('getTip maps the latest block to the normalized shape', async () => {
    const { fetchImpl, urls } = fakeFetch({ json: async () => TIP_ROW })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    const tip = await provider.getTip()

    expect(tip).toEqual({
      block: 15_243_593,
      slot: 412_162_133,
      epoch: 425,
      hash: '4ea1ba291e8eef538635a53e59fddba7810d1679631cc3aed7c8e6c4091a516a',
      blockTime: 1_641_338_934,
    })
    expect(urls[0]).toBe(`${BASE}/blocks/latest`)
  })

  it('authenticates with a project_id header, not a bearer token', async () => {
    const { fetchImpl, headersSeen } = fakeFetch({ json: async () => TIP_ROW })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await provider.getTip()

    expect(headersSeen[0]?.project_id).toBe(PROJECT_ID)
    expect(headersSeen[0]?.authorization).toBeUndefined()
  })

  it('getProtocolParams maps and normalizes the latest epoch params (regression)', async () => {
    const { fetchImpl, urls } = fakeFetch({ json: async () => EPOCH_PARAM_ROW })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    const params = await provider.getProtocolParams()

    // Full-shape assertion guards against silent mapping drift.
    expect(params).toEqual({
      epoch: 225,
      minFeeA: 44,
      minFeeB: 155_381,
      maxTxSize: 16_384,
      maxBlockBodySize: 65_536,
      keyDeposit: '2000000',
      poolDeposit: '500000000',
      minPoolCost: '340000000',
      coinsPerUtxoByte: '34482',
      maxValueSize: 5000,
      collateralPercent: 150,
      maxCollateralInputs: 3,
      priceMem: 0.0577,
      priceStep: 0.0000721,
      maxTxExMem: '10000000',
      maxTxExSteps: '10000000000',
      protocolVersion: { major: 9, minor: 0 },
      costModels: {
        PlutusV1: [100_788, 420, 1],
        PlutusV2: [100_788, 420, 1, 1],
        PlutusV3: [100_788, 420, 1, 1, 1000],
      },
    })
    expect(urls[0]).toBe(`${BASE}/epochs/latest/parameters`)
  })

  it('prefers cost_models_raw over the deprecated cost_models when both are present', async () => {
    const rows = {
      ...EPOCH_PARAM_ROW,
      cost_models: { PlutusV1: { 'addInteger-cpu-arguments-intercept': 197_209 } },
      cost_models_raw: { PlutusV1: [1, 2, 3] },
    }
    const { fetchImpl } = fakeFetch({ json: async () => rows })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    const params = await provider.getProtocolParams()

    expect(params.costModels).toEqual({ PlutusV1: [1, 2, 3] })
  })

  it('falls back to the deprecated cost_models when cost_models_raw is absent', async () => {
    const rest: Record<string, unknown> = { ...EPOCH_PARAM_ROW }
    delete rest.cost_models_raw
    const rows = { ...rest, cost_models: { PlutusV1: [9, 9] } }
    const { fetchImpl } = fakeFetch({ json: async () => rows })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    const params = await provider.getProtocolParams()

    expect(params.costModels).toEqual({ PlutusV1: [9, 9] })
  })

  it('defaults cost models to an empty object when Blockfrost has neither field', async () => {
    const rest: Record<string, unknown> = { ...EPOCH_PARAM_ROW }
    delete rest.cost_models_raw
    const rows = { ...rest, cost_models: null }
    const { fetchImpl } = fakeFetch({ json: async () => rows })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    const params = await provider.getProtocolParams()

    // This is the gap flagged in issue #4: a deployment (a bare Dingo node in particular) can
    // legitimately omit Plutus cost models, and the rest of protocol params must still be usable.
    expect(params.costModels).toEqual({})
  })

  it('strips a trailing slash from the base url', async () => {
    const { fetchImpl, urls } = fakeFetch({ json: async () => TIP_ROW })
    const provider = createBlockfrostProvider({
      baseUrl: `${BASE}/`,
      projectId: PROJECT_ID,
      fetchImpl,
    })

    await provider.getTip()

    expect(urls[0]).toBe(`${BASE}/blocks/latest`)
  })
})

describe('blockfrost provider — unhappy path', () => {
  it('throws ProviderError with the upstream status on a non-2xx response', async () => {
    const { fetchImpl } = fakeFetch({ ok: false, status: 503, text: async () => 'busy' })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.getTip()).rejects.toMatchObject({
      name: 'ProviderError',
      upstreamStatus: 503,
    })
  })

  it('wraps a network failure in ProviderError', async () => {
    const { fetchImpl } = fakeFetch({ throws: new Error('ECONNREFUSED') })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderError)
  })

  it('maps an AbortSignal timeout to ProviderTimeoutError', async () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    const { fetchImpl } = fakeFetch({ throws: timeout })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderTimeoutError)
  })

  it('throws MalformedUpstreamError when the body is not valid json', async () => {
    const { fetchImpl } = fakeFetch({
      json: async () => {
        throw new Error('unexpected token')
      },
    })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('throws MalformedUpstreamError when a required field is missing', async () => {
    const rows = { hash: 'deadbeef', epoch: 425 } // no height / slot / time
    const { fetchImpl } = fakeFetch({ json: async () => rows })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects a null tip height even though the spec marks the field nullable', async () => {
    const rows = { ...TIP_ROW, height: null }
    const { fetchImpl } = fakeFetch({ json: async () => rows })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects a non-numeric protocol-param value as malformed', async () => {
    const rows = { ...EPOCH_PARAM_ROW, key_deposit: 'not-a-number' }
    const { fetchImpl } = fakeFetch({ json: async () => rows })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.getProtocolParams()).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects a negative numeric protocol-param value as malformed', async () => {
    const rows = { ...EPOCH_PARAM_ROW, key_deposit: '-5' }
    const { fetchImpl } = fakeFetch({ json: async () => rows })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.getProtocolParams()).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('throws MalformedUpstreamError when Blockfrost returns a non-object body', async () => {
    const { fetchImpl } = fakeFetch({ json: async () => ['unexpected', 'array'] })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('maps a timeout during body parsing to ProviderTimeoutError', async () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    const { fetchImpl } = fakeFetch({
      json: async () => {
        throw timeout
      },
    })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderTimeoutError)
  })

  it('asks fetch to error on a redirect rather than follow it and leak the credential', async () => {
    // The whole point: a redirect must never be followed, because following it would re-send the
    // project_id header to the redirect target. We model native fetch's `redirect: 'error'`
    // behaviour — it rejects on a 3xx instead of chasing it — and prove the credential went to
    // Blockfrost's own host exactly once and was never sent anywhere else.
    const calls: { redirect?: string; projectId?: string }[] = []
    const fetchImpl: FetchLike = async (_url, init) => {
      calls.push({ redirect: init?.redirect, projectId: init?.headers?.project_id })
      if (init?.redirect === 'error') throw new TypeError('unexpected redirect')
      return { ok: true, status: 200, json: async () => TIP_ROW, text: async () => '' }
    }
    // readAttempts: 1 so the single rejected request is not retried; we are asserting on the exact
    // set of outbound calls, and a retry would muddy that without changing what is being proven.
    const provider = createBlockfrostProvider({
      baseUrl: BASE,
      projectId: PROJECT_ID,
      fetchImpl,
      readAttempts: 1,
    })

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderError)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.redirect).toBe('error')
    expect(calls[0]?.projectId).toBe(PROJECT_ID)
  })
})
