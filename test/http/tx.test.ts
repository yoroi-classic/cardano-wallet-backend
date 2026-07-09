import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import { ProviderError } from '../../src/domain/errors.js'

const TX_HASH = 'a'.repeat(64)

function providerWith(overrides: Partial<ChainProvider>): ChainProvider {
  const unused = async () => {
    throw new Error('unused')
  }
  return {
    name: 'fake',
    getTip: unused,
    getProtocolParams: unused,
    filterUsedAddresses: unused,
    getAccountState: unused,
    getAccountUtxos: unused,
    getTxHistory: unused,
    submitTx: async () => ({ txHash: TX_HASH }),
    getTxStatus: async () => ({ seen: true, confirmations: 3 }),
    ...overrides,
  }
}

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

describe('tx submit', () => {
  it('POST /v1/tx/submit returns the tx hash', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tx/submit',
      payload: { cbor: '84a400' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ txHash: TX_HASH })
  })

  it('rejects a missing or non-hex cbor with 400', async () => {
    app = buildServer({ provider: providerWith({}) })

    const missing = await app.inject({ method: 'POST', url: '/v1/tx/submit', payload: {} })
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })

    const nonHex = await app.inject({
      method: 'POST',
      url: '/v1/tx/submit',
      payload: { cbor: 'zzzz' },
    })
    expect(nonHex.statusCode).toBe(400)

    const oddLength = await app.inject({
      method: 'POST',
      url: '/v1/tx/submit',
      payload: { cbor: 'abc' },
    })
    expect(oddLength.statusCode).toBe(400)
  })

  it('maps a provider rejection to 502', async () => {
    app = buildServer({
      provider: providerWith({
        submitTx: async () => {
          throw new ProviderError('rejected by node', { upstreamStatus: 400 })
        },
      }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tx/submit',
      payload: { cbor: '84a400' },
    })

    expect(res.statusCode).toBe(502)
  })
})

describe('tx status', () => {
  it('GET /v1/tx/:hash/status returns confirmation status', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({ method: 'GET', url: `/v1/tx/${TX_HASH}/status` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ seen: true, confirmations: 3 })
  })

  it('rejects a malformed tx hash with 400', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({ method: 'GET', url: '/v1/tx/nothash/status' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })
})
