import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import type { TokenMetadata } from '../../src/domain/types/assets.js'
import { fakeProvider } from '../support/fake-provider.js'

const POLICY = 'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235'
const HOSKY = POLICY + '484f534b59'
const BARE = 'b'.repeat(56) // policy id only, no asset name

function token(subject: string): TokenMetadata {
  return {
    subject,
    policyId: subject.slice(0, 56),
    assetName: subject.slice(56),
    fingerprint: 'asset1abc',
    supply: '1',
    source: 'none',
  }
}

function providerWith(overrides: Partial<ChainProvider> = {}): ChainProvider {
  return fakeProvider({
    getTokenMetadata: async (subjects) => subjects.map(token),
    ...overrides,
  })
}

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

describe('assets info route', () => {
  it('POST /v1/assets/info returns metadata for the requested subjects', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/assets/info',
      payload: { subjects: [HOSKY, BARE] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().map((t: TokenMetadata) => t.subject)).toEqual([HOSKY, BARE])
  })

  it('rejects a missing or empty subjects list with 400', async () => {
    app = buildServer({ provider: providerWith({}) })

    const missing = await app.inject({ method: 'POST', url: '/v1/assets/info', payload: {} })
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })

    const empty = await app.inject({
      method: 'POST',
      url: '/v1/assets/info',
      payload: { subjects: [] },
    })
    expect(empty.statusCode).toBe(400)
  })

  it('rejects malformed subjects with 400 before hitting the provider', async () => {
    app = buildServer({
      provider: providerWith({
        getTokenMetadata: async () => {
          throw new Error('provider should not be called for a malformed subject')
        },
      }),
    })

    // Non-hex, odd length, too short (< policy id), and too long (> policy + 32-byte name).
    for (const bad of ['z'.repeat(56), 'a'.repeat(57), 'ab', 'a'.repeat(122)]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/assets/info',
        payload: { subjects: [HOSKY, bad] },
      })
      expect(res.statusCode, bad).toBe(400)
      expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
    }
  })

  it('accepts a policy-id-only subject (no asset name)', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/assets/info',
      payload: { subjects: [BARE] },
    })
    expect(res.statusCode).toBe(200)
  })
})
