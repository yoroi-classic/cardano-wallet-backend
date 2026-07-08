import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import type { AccountState, Utxo } from '../../src/domain/types.js'
import { ProviderError } from '../../src/domain/errors.js'

const STAKE = 'stake_test1uqrw9tjymlm8wrz8g8g9q2q0k3s0nq4z9m0q9c0s0'

const STATE: AccountState = {
  stakeAddress: STAKE,
  registered: true,
  balance: '1000000',
  rewardsAvailable: '0',
}

const UTXOS: Utxo[] = [
  { txHash: 'aa', outputIndex: 0, address: 'addr_test1', value: '2000000', assets: [] },
]

function providerWith(overrides: Partial<ChainProvider>): ChainProvider {
  const unused = async () => {
    throw new Error('unused')
  }
  return {
    name: 'fake',
    getTip: unused,
    getProtocolParams: unused,
    getAccountState: async () => structuredClone(STATE),
    getAccountUtxos: async () => structuredClone(UTXOS),
    submitTx: unused,
    getTxStatus: unused,
    ...overrides,
  }
}

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

describe('account routes', () => {
  it('GET /v1/account/:stake/state returns account state', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({ method: 'GET', url: `/v1/account/${STAKE}/state` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(STATE)
  })

  it('GET /v1/account/:stake/utxos returns utxos', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({ method: 'GET', url: `/v1/account/${STAKE}/utxos` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(UTXOS)
  })

  it('rejects an invalid stake address with 400 and never calls the provider', async () => {
    let called = false
    app = buildServer({
      provider: providerWith({
        getAccountState: async () => {
          called = true
          return structuredClone(STATE)
        },
      }),
    })
    const res = await app.inject({ method: 'GET', url: '/v1/account/not-a-stake/state' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
    expect(called).toBe(false)
  })

  it('maps a provider error to 502', async () => {
    app = buildServer({
      provider: providerWith({
        getAccountUtxos: async () => {
          throw new ProviderError('koios down', { upstreamStatus: 503 })
        },
      }),
    })
    const res = await app.inject({ method: 'GET', url: `/v1/account/${STAKE}/utxos` })

    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ error: { code: 'UPSTREAM_ERROR' } })
  })
})
