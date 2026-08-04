import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import { ProviderError } from '../../src/domain/errors.js'
import {
  confirmedTxStatus,
  expiredTxStatus,
  pendingTxStatus,
  rejectedTxStatus,
  unknownTxStatus,
  type TxStatus,
} from '../../src/domain/types/transactions.js'
import { fakeProvider } from '../support/fake-provider.js'

const TX_HASH = 'a'.repeat(64)

function providerWith(overrides: Partial<ChainProvider> = {}): ChainProvider {
  return fakeProvider({
    submitTx: async () => ({ txHash: TX_HASH }),
    getTxStatus: async () => confirmedTxStatus(3),
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

  it('allowlists the submit response so provider transaction material cannot escape', async () => {
    app = await buildServer({
      provider: providerWith({
        submitTx: async () =>
          ({
            txHash: TX_HASH,
            cbor: '84a400',
            address: 'addr_test1fixture',
            credential: 'private-key-fixture',
          }) as { txHash: string },
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tx/submit',
      payload: { cbor: '84a400' },
    })

    expect(res.json()).toEqual({ txHash: TX_HASH })
    expect(res.body).not.toContain('84a400')
    expect(res.body).not.toContain('addr_test1fixture')
    expect(res.body).not.toContain('private-key-fixture')
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
  it.each([
    ['unknown', unknownTxStatus()],
    ['pending', pendingTxStatus()],
    ['confirmed', confirmedTxStatus(3)],
    ['rejected', rejectedTxStatus()],
    ['expired', expiredTxStatus()],
  ] as const)(
    'GET /v1/tx/:hash/status returns the canonical %s lifecycle',
    async (_name, status) => {
      app = await buildServer({
        provider: providerWith({ getTxStatus: async () => structuredClone(status) }),
      })
      const res = await app.inject({ method: 'GET', url: `/v1/tx/${TX_HASH}/status` })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(status)
    },
  )

  it('allowlists lifecycle fields and canonicalizes terminal text', async () => {
    const providerStatus = {
      ...rejectedTxStatus(),
      terminal: {
        code: 'TX_REJECTED',
        reason: 'addr_test1secret signed bytes deadbeef',
      },
      rawProviderBody: {
        cbor: '84a400',
        address: 'addr_test1secret',
        credential: 'private-key-secret',
      },
    } as unknown as TxStatus
    app = await buildServer({
      provider: providerWith({ getTxStatus: async () => providerStatus }),
    })

    const res = await app.inject({ method: 'GET', url: `/v1/tx/${TX_HASH}/status` })
    const body = res.body

    expect(res.json()).toEqual(rejectedTxStatus())
    expect(body).not.toContain('addr_test1secret')
    expect(body).not.toContain('deadbeef')
    expect(body).not.toContain('private-key-secret')
    expect(body).not.toContain('rawProviderBody')
  })

  it('rejects an unsupported provider lifecycle without returning its fields', async () => {
    const providerStatus = {
      status: 'provider-specific-rejected',
      rawProviderBody: 'addr_test1secret private-key-secret',
    } as unknown as TxStatus
    app = await buildServer({
      provider: providerWith({ getTxStatus: async () => providerStatus }),
    })

    const res = await app.inject({ method: 'GET', url: `/v1/tx/${TX_HASH}/status` })

    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({
      error: {
        code: 'UPSTREAM_MALFORMED',
        message: 'provider returned an unsupported transaction status',
      },
    })
    expect(res.body).not.toContain('addr_test1secret')
    expect(res.body).not.toContain('private-key-secret')
    expect(res.body).not.toContain('rawProviderBody')
  })

  it('rejects an unsafe provider confirmation count as malformed upstream data', async () => {
    const providerStatus = {
      ...confirmedTxStatus(0),
      confirmations: Number.MAX_SAFE_INTEGER + 1,
    } as TxStatus
    app = await buildServer({
      provider: providerWith({ getTxStatus: async () => providerStatus }),
    })

    const res = await app.inject({ method: 'GET', url: `/v1/tx/${TX_HASH}/status` })

    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({
      error: {
        code: 'UPSTREAM_MALFORMED',
        message: 'provider returned an invalid transaction confirmation count',
      },
    })
  })

  it('rejects a malformed tx hash with 400', async () => {
    app = await buildServer({ provider: providerWith({}) })
    const res = await app.inject({ method: 'GET', url: '/v1/tx/nothash/status' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })
})
