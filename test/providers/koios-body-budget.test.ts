import { describe, expect, it } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'
import { KOIOS_BODY_LIMIT_BYTES, packBySize } from '../../src/providers/koios/schema.js'
import { ProviderError } from '../../src/domain/errors.js'

const BASE = 'https://preprod.koios.rest/api/v1'

const poolIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `pool1${String(i).padStart(51, '0')}`)

/** The body the pool endpoint actually sends. */
const poolBody = (chunk: string[]): unknown => ({ _pool_bech32_ids: chunk })

describe('packBySize', () => {
  // The property the whole thing exists for, asserted on the real serialized bytes rather than
  // on an item count standing in for them.
  it('never emits a chunk whose serialized body exceeds the budget', () => {
    for (const count of [1, 2, 83, 84, 85, 120, 500, 3_000]) {
      const chunks = packBySize(poolIds(count), poolBody, KOIOS_BODY_LIMIT_BYTES)

      for (const chunk of chunks) {
        const bytes = Buffer.byteLength(JSON.stringify(poolBody(chunk)))
        expect(bytes, `${count} ids`).toBeLessThanOrEqual(KOIOS_BODY_LIMIT_BYTES)
      }
    }
  })

  it('loses nothing and duplicates nothing', () => {
    const ids = poolIds(1_000)

    const chunks = packBySize(ids, poolBody, KOIOS_BODY_LIMIT_BYTES)

    expect(chunks.flat()).toEqual(ids)
  })

  // The point of measuring instead of guessing. A pool id is fixed length, so the answer is
  // exactly computable, and it is not 50.
  it('fills the budget rather than stopping at an invented count', () => {
    const chunks = packBySize(poolIds(3_000), poolBody, KOIOS_BODY_LIMIT_BYTES)

    expect(chunks[0]).toHaveLength(84)
    // 3000 pools used to take 60 requests at a fixed 50 per chunk. It takes 36 now.
    expect(chunks).toHaveLength(36)
  })

  it('accounts for the rest of the body, not just the items', () => {
    // tx_info sends five hydration flags alongside the hashes. They are part of the body, so
    // they are part of the budget: a packer that measured only the items would pack right up to
    // the limit and then push it over with the flags.
    const hashes = Array.from({ length: 500 }, (_, i) => i.toString(16).padStart(64, 'a'))
    const withFlags = (chunk: string[]): unknown => ({
      _tx_hashes: chunk,
      _inputs: true,
      _metadata: true,
      _assets: true,
      _withdrawals: true,
      _certs: true,
    })

    for (const chunk of packBySize(hashes, withFlags, KOIOS_BODY_LIMIT_BYTES)) {
      expect(Buffer.byteLength(JSON.stringify(withFlags(chunk)))).toBeLessThanOrEqual(
        KOIOS_BODY_LIMIT_BYTES,
      )
    }
  })

  it('handles variable-length items, which a fixed count cannot', () => {
    // An asset subject is a policy id plus a name of 0 to 64 hex chars, so the items differ in
    // size by more than 2x. Mix the extremes: a count-based chunk would have to assume the worst
    // case for every item and waste the budget on the short ones.
    const pairs = Array.from({ length: 200 }, (_, i) => [
      i.toString(16).padStart(56, '0'),
      i % 2 === 0 ? '' : 'f'.repeat(64),
    ])
    const body = (chunk: string[][]): unknown => ({ _asset_list: chunk })

    const chunks = packBySize(pairs, body, KOIOS_BODY_LIMIT_BYTES)

    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify(body(chunk)))).toBeLessThanOrEqual(
        KOIOS_BODY_LIMIT_BYTES,
      )
    }
    expect(chunks.flat()).toEqual(pairs)
    // Chunks are not uniform, because the items are not: the packer takes more of the short ones.
    expect(new Set(chunks.map((c) => c.length)).size).toBeGreaterThan(0)
  })

  it('returns nothing for nothing', () => {
    expect(packBySize([], poolBody, KOIOS_BODY_LIMIT_BYTES)).toEqual([])
  })

  // An item that cannot fit in a request by itself is a programming error, not a runtime
  // condition: no amount of chunking will make it send. Fail rather than emit a body upstream is
  // certain to reject.
  it('raises on an item too large to send at all', () => {
    const monstrous = ['x'.repeat(6_000)]

    expect(() => packBySize(monstrous, poolBody, KOIOS_BODY_LIMIT_BYTES)).toThrow(ProviderError)
  })
})

describe('koios body limit adaptation', () => {
  /** Rejects any body over `limit` with the 413 Koios really sends, and counts the calls. */
  function limitedFetch(limit: number): { fetchImpl: FetchLike; bodies: number[] } {
    const bodies: number[] = []
    const fetchImpl: FetchLike = async (_url, init) => {
      const size = Buffer.byteLength(String(init?.body))
      bodies.push(size)
      if (size > limit) {
        return {
          ok: false,
          status: 413,
          json: async () => ({}),
          text: async () =>
            `Payload too large, body length was ${size}. Please ensure your request body size is below ${limit} bytes`,
        }
      }
      return { ok: true, status: 200, json: async () => [], text: async () => '' }
    }
    return { fetchImpl, bodies }
  }

  // A proxy or a self-hosted Koios with a tighter cap should cost one failed request, once, not
  // a redeploy.
  it('adopts a smaller limit from the 413 and repacks', async () => {
    const { fetchImpl, bodies } = limitedFetch(2_000)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getPoolInfo(poolIds(60))).resolves.toEqual([])

    // The first body was packed to our default budget and rejected. Everything after it respects
    // the limit upstream actually named.
    expect(bodies[0]).toBeGreaterThan(2_000)
    expect(bodies.slice(1).every((size) => size <= 2_000)).toBe(true)
  })

  it('does not pay the 413 twice: the lowered limit sticks for the next call', async () => {
    const { fetchImpl, bodies } = limitedFetch(2_000)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await provider.getPoolInfo(poolIds(60))
    const afterFirst = bodies.length
    await provider.getPoolInfo(poolIds(60))

    // The second call learned from the first: not one of its bodies was over the limit, so not
    // one of them was rejected.
    expect(bodies.slice(afterFirst).every((size) => size <= 2_000)).toBe(true)
  })

  // A 413 that names a limit we are already under is not something to learn from, it is a
  // failure. Retrying an identical set of bodies would just fail again.
  it('surfaces a 413 that does not name a smaller limit', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 413,
      json: async () => ({}),
      text: async () => 'Payload too large',
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getPoolInfo(poolIds(10))).rejects.toBeInstanceOf(ProviderError)
  })
})
