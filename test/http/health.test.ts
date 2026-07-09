import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'

const unused = async () => {
  throw new Error('unused')
}

const stubProvider: ChainProvider = {
  name: 'stub',
  getTip: async () => ({ block: 1, slot: 1, epoch: 1, hash: 'x' }),
  getProtocolParams: unused,
  filterUsedAddresses: unused,
  getAccountState: unused,
  getAccountUtxos: unused,
  getTxHistory: unused,
  submitTx: unused,
  getTxStatus: unused,
}

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

describe('health and not-found', () => {
  it('GET /health returns ok', async () => {
    app = buildServer({ provider: stubProvider })
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', service: 'cardano-wallet-backend' })
  })

  it('unknown routes return a structured 404', async () => {
    app = buildServer({ provider: stubProvider })
    const res = await app.inject({ method: 'GET', url: '/nope' })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })
})
