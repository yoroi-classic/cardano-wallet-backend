import { afterEach, describe, expect, it } from 'vitest'
import { bech32 } from '@scure/base'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import type { PoolInfo } from '../../src/domain/types.js'

const POOL_A = 'pool1wn6a6f23ctq06udwhw27ravdpd6zcr7jlut3yez0wzdackz3222'
const POOL_B = 'pool174mw7e20768e8vj4fn8y6p536n8rkzswsapwtwn354dckpjqzr8'
// Valid bech32 with the `pool` HRP but a 20-byte payload, not the required 28-byte hash.
const POOL_WRONG_SIZE = bech32.encode('pool', bech32.toWords(new Uint8Array(20)), 1023)

function poolInfo(poolId: string): PoolInfo {
  return {
    poolId,
    poolIdHex: 'aa',
    status: 'registered',
    margin: 0.02,
    fixedCost: '340000000',
    pledge: '0',
    livePledge: '0',
    activeStake: '1',
    liveStake: '1',
    saturation: 0.5,
    liveDelegators: 1,
    blocksMinted: 1,
  }
}

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
    getPoolInfo: async (ids) => ids.map(poolInfo),
    submitTx: unused,
    getTxStatus: unused,
    ...overrides,
  }
}

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

describe('pools info route', () => {
  it('POST /v1/pools/info returns info for the requested pools', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pools/info',
      payload: { poolIds: [POOL_A, POOL_B] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().map((p: PoolInfo) => p.poolId)).toEqual([POOL_A, POOL_B])
  })

  it('rejects a missing poolIds list with 400', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({ method: 'POST', url: '/v1/pools/info', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('rejects an empty poolIds list with 400', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pools/info',
      payload: { poolIds: [] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('rejects a malformed pool id with 400 before hitting the provider', async () => {
    app = buildServer({
      provider: providerWith({
        getPoolInfo: async () => {
          throw new Error('provider should not be called for a malformed pool id')
        },
      }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pools/info',
      payload: { poolIds: [POOL_A, 'not-a-pool-id'] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('rejects a stake address in the pool slot (wrong bech32 hrp) with 400', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pools/info',
      payload: { poolIds: ['stake_test1uqrw9tjymlm8wrz8g8g9q2q0k3s0nq4z9m0q9c0s0'] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a well-formed pool id whose key hash is not 28 bytes with 400', async () => {
    app = buildServer({
      provider: providerWith({
        getPoolInfo: async () => {
          throw new Error('provider should not be called for a wrong-size pool id')
        },
      }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pools/info',
      payload: { poolIds: [POOL_WRONG_SIZE] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })
})
