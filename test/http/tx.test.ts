import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import { ProviderError } from '../../src/domain/errors.js'
import { fakeProvider } from '../support/fake-provider.js'

const TX_HASH = 'a'.repeat(64)

function providerWith(overrides: Partial<ChainProvider> = {}): ChainProvider {
  return fakeProvider({
    submitTx: async () => ({ txHash: TX_HASH }),
    getTxStatus: async () => ({ seen: true, confirmations: 3 }),
    ...overrides,
  })
}

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

describe('tx submit', () => {
  it('POST /v1/tx/submit returns the tx hash', async () => {
    app = await buildServer({ provider: providerWith({}) })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tx/submit',
      payload: { cbor: '84a400' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ txHash: TX_HASH })
  })

  it('rejects a missing or non-hex cbor with 400', async () => {
    app = await buildServer({ provider: providerWith({}) })

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
    app = await buildServer({
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
    app = await buildServer({ provider: providerWith({}) })
    const res = await app.inject({ method: 'GET', url: `/v1/tx/${TX_HASH}/status` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ seen: true, confirmations: 3 })
  })

  it.each([
    ['lowercase', TX_HASH],
    ['uppercase', TX_HASH.toUpperCase()],
    ['mixed case', `${'A'.repeat(32)}${'a'.repeat(32)}`],
  ])('normalizes an accepted %s hash before calling the provider', async (_case, requested) => {
    let received: string | undefined
    app = await buildServer({
      provider: providerWith({
        getTxStatus: async (hash) => {
          received = hash
          return { seen: false, confirmations: 0 }
        },
      }),
    })

    const res = await app.inject({ method: 'GET', url: `/v1/tx/${requested}/status` })

    expect(res.statusCode).toBe(200)
    expect(received).toBe(requested.toLowerCase())
  })

  it('rejects a malformed tx hash with 400', async () => {
    app = await buildServer({ provider: providerWith({}) })
    const res = await app.inject({ method: 'GET', url: '/v1/tx/nothash/status' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })
})
