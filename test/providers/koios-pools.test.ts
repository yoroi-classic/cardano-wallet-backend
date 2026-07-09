import { describe, expect, it } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios.js'
import { MalformedUpstreamError } from '../../src/domain/errors.js'

const BASE = 'https://preprod.koios.rest/api/v1'
const POOL_A = 'pool1wn6a6f23ctq06udwhw27ravdpd6zcr7jlut3yez0wzdackz3222'
const POOL_B = 'pool174mw7e20768e8vj4fn8y6p536n8rkzswsapwtwn354dckpjqzr8'

interface Call {
  url: string
  method?: string
  body?: string | Uint8Array
}

function fakeFetch(json: () => Promise<unknown>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body })
    return { ok: true, status: 200, json, text: async () => '' }
  }
  return { fetchImpl, calls }
}

// Shaped after a live Koios preprod /pool_info row.
const ROW_A = {
  pool_id_bech32: POOL_A,
  pool_id_hex: '74f5dd2551c2c0fd71aebb95e1f58d0b742c0fd2ff1712644f709bdc',
  pool_status: 'registered',
  retiring_epoch: null,
  margin: 0.22,
  fixed_cost: '777000000',
  pledge: '44400000000',
  live_pledge: '261113197656',
  active_stake: '1990584779091',
  live_stake: '1995704621789',
  live_saturation: 3.12,
  live_delegators: 104,
  block_count: 24497,
  meta_json: {
    name: 'ANGEL stake pool',
    ticker: 'ANGEL',
    homepage: 'https://www.angelstakepool.net',
    description: 'ANGEL pool at pre-production',
  },
}

describe('koios getPoolInfo', () => {
  it('maps a full pool row and posts the bech32 ids', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [ROW_A])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [pool] = await provider.getPoolInfo([POOL_A])

    // 3.12% saturation normalized to a fraction (checked separately for float precision).
    expect(pool?.saturation).toBeCloseTo(0.0312, 12)
    expect({ ...pool, saturation: 0 }).toEqual({
      poolId: POOL_A,
      poolIdHex: '74f5dd2551c2c0fd71aebb95e1f58d0b742c0fd2ff1712644f709bdc',
      status: 'registered',
      retiringEpoch: undefined,
      margin: 0.22,
      fixedCost: '777000000',
      pledge: '44400000000',
      livePledge: '261113197656',
      activeStake: '1990584779091',
      liveStake: '1995704621789',
      saturation: 0,
      liveDelegators: 104,
      blocksMinted: 24497,
      metadata: {
        name: 'ANGEL stake pool',
        ticker: 'ANGEL',
        homepage: 'https://www.angelstakepool.net',
        description: 'ANGEL pool at pre-production',
      },
    })
    expect(calls[0]?.url).toBe(`${BASE}/pool_info`)
    expect(calls[0]?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ _pool_bech32_ids: [POOL_A] })
  })

  it('returns pools in the caller order and omits unknown ids', async () => {
    // Koios responds unordered and without a row for an unknown pool.
    const { fetchImpl } = fakeFetch(async () => [
      { ...ROW_A, pool_id_bech32: POOL_B, pool_id_hex: 'ff', meta_json: null },
      ROW_A,
    ])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const pools = await provider.getPoolInfo([POOL_A, 'pool1unknown', POOL_B])

    expect(pools.map((p) => p.poolId)).toEqual([POOL_A, POOL_B])
  })

  it('defaults nullable stats and drops absent metadata', async () => {
    const { fetchImpl } = fakeFetch(async () => [
      {
        pool_id_bech32: POOL_A,
        pool_id_hex: 'aa',
        pool_status: 'retiring',
        retiring_epoch: 130,
        margin: 0,
        fixed_cost: null,
        pledge: null,
        live_pledge: null,
        active_stake: null,
        live_stake: null,
        live_saturation: null,
        live_delegators: null,
        block_count: null,
        meta_json: null,
      },
    ])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [pool] = await provider.getPoolInfo([POOL_A])

    expect(pool).toEqual({
      poolId: POOL_A,
      poolIdHex: 'aa',
      status: 'retiring',
      retiringEpoch: 130,
      margin: 0,
      fixedCost: '0',
      pledge: '0',
      livePledge: '0',
      activeStake: '0',
      liveStake: '0',
      saturation: 0,
      liveDelegators: 0,
      blocksMinted: 0,
      metadata: undefined,
    })
  })

  it('keeps only the metadata fields the pool actually registered', async () => {
    const { fetchImpl } = fakeFetch(async () => [
      { ...ROW_A, meta_json: { ticker: 'ONLY', name: null, homepage: null, description: null } },
    ])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [pool] = await provider.getPoolInfo([POOL_A])

    expect(pool?.metadata).toEqual({ ticker: 'ONLY' })
  })

  it('returns [] without calling upstream for an empty batch', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [ROW_A])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    expect(await provider.getPoolInfo([])).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('rejects an unexpected pool_status as malformed upstream', async () => {
    const { fetchImpl } = fakeFetch(async () => [{ ...ROW_A, pool_status: 'gone' }])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getPoolInfo([POOL_A])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})
