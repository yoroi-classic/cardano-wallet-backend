import { afterEach, describe, expect, it } from 'vitest'
import { bech32 } from '@scure/base'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'

// Two well-formed addr_test payment addresses so the route's bech32 validation passes;
// the bytes are arbitrary but produce a valid HRP + checksum.
function addrTest(fill: number): string {
  return bech32.encode('addr_test', bech32.toWords(new Uint8Array(57).fill(fill)), 1023)
}
const USED = addrTest(1)
const UNUSED = addrTest(2)

// Valid bech32 under the addr_test HRP, but the Shelley header names type 15 (a
// stake/reward address kind), not a payment address.
function nonPaymentTypeAddress(): string {
  const bytes = new Uint8Array(29)
  bytes[0] = 0xf0
  return bech32.encode('addr_test', bech32.toWords(bytes), 1023)
}
const NON_PAYMENT_TYPE = nonPaymentTypeAddress()

function providerWith(overrides: Partial<ChainProvider>): ChainProvider {
  const unused = async () => {
    throw new Error('unused')
  }
  return {
    name: 'fake',
    getTip: unused,
    getProtocolParams: unused,
    filterUsedAddresses: async (addresses) => addresses.filter((a) => a === USED),
    getAccountState: unused,
    getAccountUtxos: unused,
    getTxHistory: unused,
    submitTx: unused,
    getTxStatus: unused,
    getPoolInfo: unused,
    getPoolList: unused,
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
      payload: { addresses: [USED, UNUSED] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([USED])
  })

  it('rejects a missing addresses list with 400', async () => {
    app = buildServer({ provider: providerWith({}) })

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: {},
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('rejects an empty addresses list with 400', async () => {
    app = buildServer({ provider: providerWith({}) })

    const empty = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: { addresses: [] },
    })
    expect(empty.statusCode).toBe(400)
    expect(empty.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('rejects a malformed address with 400 before hitting the provider', async () => {
    app = buildServer({
      provider: providerWith({
        filterUsedAddresses: async () => {
          throw new Error('provider should not be called for a malformed address')
        },
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: { addresses: [USED, 'not-a-bech32-address'] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('rejects a well-formed non-payment (stake-type) address with 400', async () => {
    app = buildServer({
      provider: providerWith({
        filterUsedAddresses: async () => {
          throw new Error('provider should not be called for a non-payment address')
        },
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: { addresses: [NON_PAYMENT_TYPE] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })
})
