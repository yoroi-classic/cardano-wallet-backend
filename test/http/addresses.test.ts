import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'

function providerWith(overrides: Partial<ChainProvider>): ChainProvider {
  const unused = async () => {
    throw new Error('unused')
  }
  return {
    name: 'fake',
    getTip: unused,
    getProtocolParams: unused,
    filterUsedAddresses: async (addresses) => addresses.filter((a) => a.startsWith('used')),
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

describe('filter-used route', () => {
  it('POST /v1/addresses/filter-used returns the used subset', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: { addresses: ['used1', 'unused2', 'used3'] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(['used1', 'used3'])
  })

  it('rejects a missing or empty addresses list with 400', async () => {
    app = buildServer({ provider: providerWith({}) })

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: {},
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })

    const empty = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: { addresses: [] },
    })
    expect(empty.statusCode).toBe(400)
  })
})
