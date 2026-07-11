import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import { fakeProvider } from '../support/fake-provider.js'

// Neither route touches the provider, so nothing needs stubbing: any call would throw.
const stubProvider = fakeProvider()

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
