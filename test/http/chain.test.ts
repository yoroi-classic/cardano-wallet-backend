import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import type { ProtocolParams, Tip } from '../../src/domain/types.js'
import { ProviderError, ProviderTimeoutError } from '../../src/domain/errors.js'

const TIP: Tip = { block: 3_500_000, slot: 86_400_123, epoch: 199, hash: 'aa11bb22' }

const PARAMS: ProtocolParams = {
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
  costModels: { PlutusV1: [100] },
}

/**
 * A provider whose behavior each test controls. The defaults return clones so an
 * accidental in-place mutation in a route or serializer would fail the assertion
 * instead of silently mutating the shared fixture too.
 */
function providerWith(overrides: Partial<ChainProvider>): ChainProvider {
  const unused = async () => {
    throw new Error('unused')
  }
  return {
    name: 'fake',
    getTip: async () => structuredClone(TIP),
    getProtocolParams: async () => structuredClone(PARAMS),
    getAccountState: unused,
    getAccountUtxos: unused,
    getTxHistory: unused,
    submitTx: unused,
    getTxStatus: unused,
    ...overrides,
  }
}

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

describe('chain routes — happy path', () => {
  it('GET /v1/chain/tip returns the normalized tip', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({ method: 'GET', url: '/v1/chain/tip' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(TIP)
  })

  it('GET /v1/chain/protocol-params returns the normalized params (regression)', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({ method: 'GET', url: '/v1/chain/protocol-params' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(PARAMS)
  })
})

describe('chain routes — unhappy path', () => {
  it('maps a ProviderError to 502 with a stable body', async () => {
    app = buildServer({
      provider: providerWith({
        getTip: async () => {
          throw new ProviderError('koios returned 500 for /tip', { upstreamStatus: 500 })
        },
      }),
    })
    const res = await app.inject({ method: 'GET', url: '/v1/chain/tip' })

    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({
      error: { code: 'UPSTREAM_ERROR', message: 'koios returned 500 for /tip' },
    })
  })

  it('maps a ProviderTimeoutError to 504', async () => {
    app = buildServer({
      provider: providerWith({
        getTip: async () => {
          throw new ProviderTimeoutError('koios request timed out: /tip')
        },
      }),
    })
    const res = await app.inject({ method: 'GET', url: '/v1/chain/tip' })

    expect(res.statusCode).toBe(504)
    expect(res.json()).toMatchObject({ error: { code: 'UPSTREAM_TIMEOUT' } })
  })

  it('never leaks internal error detail on an unexpected throw', async () => {
    app = buildServer({
      provider: providerWith({
        getTip: async () => {
          throw new Error('secret internal detail')
        },
      }),
    })
    const res = await app.inject({ method: 'GET', url: '/v1/chain/tip' })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'internal server error' } })
    expect(res.payload).not.toContain('secret internal detail')
  })
})
