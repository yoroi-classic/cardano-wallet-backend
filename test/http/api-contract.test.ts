import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ProtocolParams, Tip } from '../../src/domain/types.js'
import {
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../../src/domain/errors.js'
import type { ChainProvider } from '../../src/providers/provider.js'

const TIP: Tip = {
  block: 3_500_000,
  slot: 86_400_123,
  epoch: 199,
  hash: 'aa11bb22',
}

const PROTOCOL_PARAMS: ProtocolParams = {
  epoch: 199,
  minFeeA: 44,
  minFeeB: 155_381,
  maxTxSize: 16_384,
  maxBlockBodySize: 90_112,
  keyDeposit: '2000000',
  poolDeposit: '500000000',
  minPoolCost: '170000000',
  coinsPerUtxoByte: '4310',
  maxValueSize: 5000,
  collateralPercent: 150,
  maxCollateralInputs: 3,
  priceMem: 0.0577,
  priceStep: 0.0000721,
  maxTxExMem: '14000000',
  maxTxExSteps: '10000000000',
  protocolVersion: { major: 9, minor: 0 },
  costModels: { PlutusV1: [100, 200], PlutusV2: [300] },
}

interface ProviderCallCounts {
  tip: number
  protocolParams: number
}

function providerWith(
  overrides: Partial<ChainProvider> = {},
  calls: ProviderCallCounts = { tip: 0, protocolParams: 0 },
): ChainProvider {
  const unused = async () => {
    throw new Error('unused')
  }
  return {
    name: 'contract-test',
    getTip: async () => {
      calls.tip += 1
      return structuredClone(TIP)
    },
    getProtocolParams: async () => {
      calls.protocolParams += 1
      return structuredClone(PROTOCOL_PARAMS)
    },
    filterUsedAddresses: unused,
    getAccountState: unused,
    getAccountUtxos: unused,
    getTxHistory: unused,
    getPoolInfo: unused,
    getPoolList: unused,
    getTokenMetadata: unused,
    getDrepInfo: unused,
    getDrepList: unused,
    submitTx: unused,
    getTxStatus: unused,
    ...overrides,
  }
}

function expectJson(res: { headers: Record<string, unknown> }): void {
  expect(String(res.headers['content-type'])).toContain('application/json')
}

let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('backend API contract', () => {
  it('GET /health returns a stable JSON envelope without touching providers', async () => {
    const calls = { tip: 0, protocolParams: 0 }
    app = buildServer({ provider: providerWith({}, calls) })

    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expectJson(res)
    expect(res.json()).toEqual({ status: 'ok', service: 'cardano-wallet-backend' })
    expect(calls).toEqual({ tip: 0, protocolParams: 0 })
  })

  it('GET /v1/chain/tip exposes only the wallet contract fields', async () => {
    const providerTip = {
      ...TIP,
      providerDebug: { source: 'koios', requestId: 'internal' },
    } as Tip
    app = buildServer({ provider: providerWith({ getTip: async () => providerTip }) })

    const res = await app.inject({ method: 'GET', url: '/v1/chain/tip' })

    expect(res.statusCode).toBe(200)
    expectJson(res)
    expect(res.json()).toEqual(TIP)
  })

  it('GET /v1/chain/protocol-params exposes the normalized wallet shape', async () => {
    const providerParams = {
      ...PROTOCOL_PARAMS,
      protocolVersion: { major: 9, minor: 0, providerEra: 'conway' },
      providerDebug: { source: 'koios', requestId: 'internal' },
    } as unknown as ProtocolParams
    app = buildServer({
      provider: providerWith({ getProtocolParams: async () => providerParams }),
    })

    const res = await app.inject({ method: 'GET', url: '/v1/chain/protocol-params' })

    expect(res.statusCode).toBe(200)
    expectJson(res)
    expect(res.json()).toEqual(PROTOCOL_PARAMS)
  })

  it('keeps optional cost models present with an empty default', async () => {
    const providerParams = {
      ...PROTOCOL_PARAMS,
      costModels: undefined,
    } as unknown as ProtocolParams
    app = buildServer({
      provider: providerWith({ getProtocolParams: async () => providerParams }),
    })

    const res = await app.inject({ method: 'GET', url: '/v1/chain/protocol-params' })

    expect(res.statusCode).toBe(200)
    expectJson(res)
    expect(res.json()).toEqual({ ...PROTOCOL_PARAMS, costModels: {} })
  })

  it('rejects unsupported methods before provider code runs', async () => {
    const calls = { tip: 0, protocolParams: 0 }
    app = buildServer({ provider: providerWith({}, calls) })

    const res = await app.inject({ method: 'POST', url: '/v1/chain/tip', payload: {} })

    expect(res.statusCode).toBe(404)
    expectJson(res)
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'route POST /v1/chain/tip not found' },
    })
    expect(calls).toEqual({ tip: 0, protocolParams: 0 })
  })
})

describe('backend API provider failure contract', () => {
  it.each([
    [
      'upstream failure',
      new ProviderError('provider returned 503', { upstreamStatus: 503 }),
      502,
      { error: { code: 'UPSTREAM_ERROR', message: 'provider returned 503' } },
    ],
    [
      'malformed upstream data',
      new MalformedUpstreamError('provider response shape mismatch'),
      502,
      { error: { code: 'UPSTREAM_MALFORMED', message: 'provider response shape mismatch' } },
    ],
    [
      'upstream timeout',
      new ProviderTimeoutError('provider request timed out'),
      504,
      { error: { code: 'UPSTREAM_TIMEOUT', message: 'provider request timed out' } },
    ],
  ])('maps %s to the stable error envelope', async (_name, error, statusCode, body) => {
    app = buildServer({
      provider: providerWith({
        getTip: async () => {
          throw error
        },
      }),
    })

    const res = await app.inject({ method: 'GET', url: '/v1/chain/tip' })

    expect(res.statusCode).toBe(statusCode)
    expectJson(res)
    expect(res.json()).toEqual(body)
  })
})
