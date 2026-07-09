import { afterEach, describe, expect, it } from 'vitest'
import { bech32 } from '@scure/base'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import type { DrepInfo } from '../../src/domain/types.js'

const DREP_A = 'drep1ygpuetneftlmufa97hm5mf3xvqpdkyw656hyg6h20qaewtg3csnkc'
const DREP_B = 'drep1y07lewz4r9svtyymalt0a8x0uapsra7xfwtu4df3n9mna2quw7syr'

// A CIP-129 payload: the given 1-byte header, then the 28-byte credential.
function cip129(header: number): Uint8Array {
  return Buffer.concat([Buffer.from([header]), Buffer.alloc(28)])
}

function drep(drepId: string): DrepInfo {
  return {
    drepId,
    hex: 'ab',
    hasScript: false,
    status: 'registered',
    active: true,
    deposit: '500000000',
    votingPower: '1',
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
    getPoolInfo: unused,
    getPoolList: unused,
    getTokenMetadata: unused,
    getDrepInfo: async (ids) => ids.map(drep),
    getDrepList: async ({ limit }) => [DREP_A, DREP_B].slice(0, limit).map(drep),
    submitTx: unused,
    getTxStatus: unused,
    ...overrides,
  }
}

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

describe('governance drep routes', () => {
  it('GET /v1/governance/dreps returns a page with default paging', async () => {
    let seen: unknown
    app = buildServer({
      provider: providerWith({
        getDrepList: async (params) => {
          seen = params
          return [drep(DREP_A), drep(DREP_B)]
        },
      }),
    })
    const res = await app.inject({ method: 'GET', url: '/v1/governance/dreps' })

    expect(res.statusCode).toBe(200)
    expect(res.json().map((d: DrepInfo) => d.drepId)).toEqual([DREP_A, DREP_B])
    expect(seen).toEqual({ limit: 50, offset: 0 })
  })

  it('rejects out-of-range paging with 400', async () => {
    app = buildServer({ provider: providerWith({}) })
    for (const q of ['limit=0', 'limit=251', 'offset=-1']) {
      const res = await app.inject({ method: 'GET', url: `/v1/governance/dreps?${q}` })
      expect(res.statusCode, q).toBe(400)
    }
  })

  it('POST /v1/governance/dreps/info returns info for the requested dreps', async () => {
    app = buildServer({ provider: providerWith({}) })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/governance/dreps/info',
      payload: { drepIds: [DREP_A, DREP_B] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().map((d: DrepInfo) => d.drepId)).toEqual([DREP_A, DREP_B])
  })

  it('rejects a missing or empty drepIds list with 400', async () => {
    app = buildServer({ provider: providerWith({}) })

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/governance/dreps/info',
      payload: {},
    })
    expect(missing.statusCode).toBe(400)

    const empty = await app.inject({
      method: 'POST',
      url: '/v1/governance/dreps/info',
      payload: { drepIds: [] },
    })
    expect(empty.statusCode).toBe(400)
  })

  it('rejects a malformed drep id (wrong hrp) with 400 before hitting the provider', async () => {
    app = buildServer({
      provider: providerWith({
        getDrepInfo: async () => {
          throw new Error('provider should not be called for a malformed drep id')
        },
      }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/governance/dreps/info',
      payload: { drepIds: [DREP_A, 'pool1wn6a6f23ctq06udwhw27ravdpd6zcr7jlut3yez0wzdackz3222'] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  // Checking only the bech32 HRP is not enough. `drep1qqdfn8lc` has a valid checksum and the
  // right prefix but decodes to a single byte, so an HRP-only check would wave it through to
  // the provider. A DRep id carries a 28-byte credential, optionally behind a CIP-129 header.
  it.each([
    ['a one-byte payload', 'drep1qqdfn8lc'],
    ['a 20-byte payload', bech32.encode('drep', bech32.toWords(new Uint8Array(20)), 1023)],
    [
      'a 29-byte payload with an unknown header',
      bech32.encode(
        'drep',
        bech32.toWords(Buffer.concat([Buffer.from([0x11]), Buffer.alloc(28)])),
        1023,
      ),
    ],
    ['bad 5-bit padding', bech32.encode('drep', [...bech32.toWords(new Uint8Array(28)), 31], 1023)],
  ])('rejects a checksum-valid drep id with %s with 400', async (_case, badId) => {
    app = buildServer({
      provider: providerWith({
        getDrepInfo: async () => {
          throw new Error('provider should not be called for a malformed drep id')
        },
      }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/governance/dreps/info',
      payload: { drepIds: [badId] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  // CIP-105 is deprecated in favour of CIP-129, but ids in that form are still in
  // circulation and are still resolvable upstream, so the boundary must not reject them.
  it.each([
    ['CIP-129 key hash', bech32.encode('drep', bech32.toWords(cip129(0x22)), 1023)],
    ['CIP-129 script hash', bech32.encode('drep', bech32.toWords(cip129(0x23)), 1023)],
    ['deprecated CIP-105', bech32.encode('drep', bech32.toWords(new Uint8Array(28)), 1023)],
  ])('accepts a %s drep id', async (_form, id) => {
    let seen: string[] = []
    app = buildServer({
      provider: providerWith({
        getDrepInfo: async (ids) => {
          seen = ids
          return []
        },
      }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/governance/dreps/info',
      payload: { drepIds: [id] },
    })
    expect(res.statusCode).toBe(200)
    expect(seen).toEqual([id])
  })
})
