import { afterEach, describe, expect, it } from 'vitest'
import { bech32 } from '@scure/base'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import type { PoolInfo } from '../../src/domain/types/pools.js'
import { fakeProvider } from '../support/fake-provider.js'

const POOL_A = 'pool1wn6a6f23ctq06udwhw27ravdpd6zcr7jlut3yez0wzdackz3222'
const POOL_B = 'pool174mw7e20768e8vj4fn8y6p536n8rkzswsapwtwn354dckpjqzr8'
// Valid bech32 with the `pool` HRP but a 20-byte payload, not the required 28-byte hash.
const POOL_WRONG_SIZE = bech32.encode('pool', bech32.toWords(new Uint8Array(20)), 1023)
// A well-formed 28-byte bech32 value under a non-pool prefix, to exercise the HRP check.
const STAKE_HRP_VALUE = bech32.encode('stake', bech32.toWords(new Uint8Array(28)), 1023)
// Good checksum, `pool` prefix, but a trailing word that leaves non-zero padding, so
// converting the words back to bytes fails.
const POOL_BAD_PADDING = bech32.encode('pool', [...bech32.toWords(new Uint8Array(28)), 31], 1023)

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

function providerWith(overrides: Partial<ChainProvider> = {}): ChainProvider {
  return fakeProvider({
    getPoolInfo: async (ids) => ids.map(poolInfo),
    getPoolList: async ({ limit, ticker }) => {
      const ids = ticker ? [POOL_A] : [POOL_A, POOL_B]
      return ids.slice(0, limit).map(poolInfo)
    },
    ...overrides,
  })
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

  // The payload here is a real 28-byte bech32 value with a good checksum, carrying the
  // `stake` prefix. It has to fail on the HRP check specifically, not on the decode, or
  // this stops covering the wrong-HRP path at all.
  it('rejects a valid bech32 value with the wrong hrp (not pool) with 400', async () => {
    app = buildServer({
      provider: providerWith({
        getPoolInfo: async () => {
          throw new Error('provider should not be called for a wrong-hrp value')
        },
      }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pools/info',
      payload: { poolIds: [STAKE_HRP_VALUE] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  // A good checksum does not mean the 5-bit payload converts back to bytes. This value
  // decodes and carries the `pool` prefix, but its trailing padding is non-zero, so the
  // throwing converter would blow up inside the handler and turn bad input into a 500.
  it('rejects a checksum-valid pool id with bad padding with 400, not 500', async () => {
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
      payload: { poolIds: [POOL_BAD_PADDING] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
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

describe('pools list route', () => {
  it('GET /v1/pools returns a page with default paging', async () => {
    let seen: unknown
    app = buildServer({
      provider: providerWith({
        getPoolList: async (params) => {
          seen = params
          return [poolInfo(POOL_A), poolInfo(POOL_B)]
        },
      }),
    })
    const res = await app.inject({ method: 'GET', url: '/v1/pools' })

    expect(res.statusCode).toBe(200)
    expect(res.json().map((p: PoolInfo) => p.poolId)).toEqual([POOL_A, POOL_B])
    // Defaults are applied at the boundary and forwarded to the provider.
    expect(seen).toEqual({ limit: 50, offset: 0 })
  })

  it('forwards limit, offset, and ticker to the provider', async () => {
    let seen: unknown
    app = buildServer({
      provider: providerWith({
        getPoolList: async (params) => {
          seen = params
          return [poolInfo(POOL_A)]
        },
      }),
    })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/pools?limit=10&offset=20&ticker=ANGEL',
    })

    expect(res.statusCode).toBe(200)
    expect(seen).toEqual({ limit: 10, offset: 20, ticker: 'ANGEL' })
  })

  it('rejects out-of-range limit and offset with 400', async () => {
    app = buildServer({ provider: providerWith({}) })

    for (const q of ['limit=0', 'limit=251', 'limit=abc', 'offset=-1']) {
      const res = await app.inject({ method: 'GET', url: `/v1/pools?${q}` })
      expect(res.statusCode, q).toBe(400)
      expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
    }
  })

  it('rejects a ticker with non-alphanumeric characters with 400', async () => {
    app = buildServer({
      provider: providerWith({
        getPoolList: async () => {
          throw new Error('provider should not be called for a malformed ticker')
        },
      }),
    })
    // A comma would be PostgREST filter syntax if it reached the upstream query.
    const res = await app.inject({ method: 'GET', url: '/v1/pools?ticker=AN,GEL' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })
})
