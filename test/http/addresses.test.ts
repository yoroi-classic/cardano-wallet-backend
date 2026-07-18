import { afterEach, describe, expect, it } from 'vitest'
import { bech32 } from '@scure/base'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import type { Utxo, WalletTransaction } from '../../src/domain/types/transactions.js'
import { ProviderError } from '../../src/domain/errors.js'
import { fakeProvider } from '../support/fake-provider.js'

// Two well-formed addr_test payment addresses so the route's bech32 validation passes;
// the bytes are arbitrary but produce a valid HRP + checksum.
function addrTest(fill: number): string {
  return bech32.encode('addr_test', bech32.toWords(new Uint8Array(57).fill(fill)), 1023)
}
const USED = addrTest(1)
const UNUSED = addrTest(2)

// Real, live-verified Byron addresses (see the comment on the same fixtures in
// test/domain/byron-address.test.ts), not placeholder strings: the branded address types
// accept any string, so a fake like "addr_test1_first" would never exercise real decoding
// and is exactly how this bug went unnoticed once already.
const BYRON_ICARUS = 'Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi'
const BYRON_DAEDALUS =
  'DdzFFzCqrht9W56zJGEFvHHywdeXZiGVYGqVhoZj6SRrS9o2HNLmorEzZhKm7khqfBKvCaTKGLtTnQSToxuvdzJTkQqcAf6f2ErxbSKS'
// Truncated real base58: valid charset, but the CBOR/CRC structure no longer lines up.
const MALFORMED_BYRON = BYRON_ICARUS.slice(0, BYRON_ICARUS.length - 5)

// Valid bech32 under the addr_test HRP, but the Shelley header names type 15 (a
// stake/reward address kind), not a payment address.
function nonPaymentTypeAddress(): string {
  const bytes = new Uint8Array(29)
  bytes[0] = 0xf0
  return bech32.encode('addr_test', bech32.toWords(bytes), 1023)
}
const NON_PAYMENT_TYPE = nonPaymentTypeAddress()

function providerWith(overrides: Partial<ChainProvider> = {}): ChainProvider {
  return fakeProvider({
    filterUsedAddresses: async (addresses) => addresses.filter((a) => a === USED),
    ...overrides,
  })
}

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

describe('filter-used route', () => {
  it('POST /v1/addresses/filter-used returns the used subset', async () => {
    app = await buildServer({ provider: providerWith({}) })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: { addresses: [USED, UNUSED] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([USED])
  })

  it('rejects a missing addresses list with 400', async () => {
    app = await buildServer({ provider: providerWith({}) })

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: {},
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('rejects an empty addresses list with 400', async () => {
    app = await buildServer({ provider: providerWith({}) })

    const empty = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: { addresses: [] },
    })
    expect(empty.statusCode).toBe(400)
    expect(empty.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('rejects a malformed address with 400 before hitting the provider', async () => {
    app = await buildServer({
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
    app = await buildServer({
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

  // The bug this issue fixes: Byron wallets 400 on every address, because the validator only
  // ever accepted bech32.
  it('accepts a real Byron (Icarus-style) address and forwards it to the provider', async () => {
    let seen: string[] = []
    app = await buildServer({
      provider: providerWith({
        filterUsedAddresses: async (addresses) => {
          seen = addresses
          return addresses.filter((a) => a === BYRON_ICARUS)
        },
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: { addresses: [BYRON_ICARUS] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([BYRON_ICARUS])
    expect(seen).toEqual([BYRON_ICARUS])
  })

  it('accepts a real Byron (Daedalus-style) address', async () => {
    app = await buildServer({
      provider: providerWith({
        filterUsedAddresses: async (addresses) => addresses,
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: { addresses: [BYRON_DAEDALUS] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([BYRON_DAEDALUS])
  })

  // The mixed-batch question the issue leaves open: a batch mixing genuinely valid Byron and
  // genuinely valid Shelley addresses is not rejected as a batch. Each address is validated
  // independently, so mixing kinds was never actually the problem; unconditionally rejecting
  // Byron was.
  it('accepts a batch mixing valid Byron and valid Shelley addresses', async () => {
    app = await buildServer({
      provider: providerWith({
        filterUsedAddresses: async (addresses) =>
          addresses.filter((a) => a === USED || a === BYRON_ICARUS),
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: { addresses: [USED, BYRON_ICARUS, UNUSED] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([USED, BYRON_ICARUS])
  })

  it('rejects a malformed Byron-looking address (truncated base58) with 400', async () => {
    app = await buildServer({
      provider: providerWith({
        filterUsedAddresses: async () => {
          throw new Error('provider should not be called for a malformed Byron address')
        },
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: { addresses: [MALFORMED_BYRON] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  // Still the sharp edge from the issue, just no longer triggered by a legitimate Byron
  // address: one malformed entry fails the whole batch under .every().
  it('rejects a batch where one otherwise-valid-looking entry is malformed', async () => {
    app = await buildServer({
      provider: providerWith({
        filterUsedAddresses: async () => {
          throw new Error('provider should not be called when one entry is malformed')
        },
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/filter-used',
      payload: { addresses: [USED, MALFORMED_BYRON] },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /v1/addresses/utxos', () => {
  const utxo = (address: string): Utxo => ({
    txHash: 'a'.repeat(64),
    outputIndex: 0,
    address,
    value: '2000000',
    assets: [],
  })

  it('returns UTxOs mapped from the provider for a Byron address', async () => {
    app = await buildServer({
      provider: fakeProvider({
        getUtxosByAddresses: async (addresses) => addresses.map(utxo),
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/utxos',
      payload: { addresses: [BYRON_ICARUS] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([utxo(BYRON_ICARUS)])
  })

  it('accepts a batch mixing Byron and Shelley addresses', async () => {
    app = await buildServer({
      provider: fakeProvider({
        getUtxosByAddresses: async (addresses) => addresses.map(utxo),
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/utxos',
      payload: { addresses: [BYRON_ICARUS, USED] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([utxo(BYRON_ICARUS), utxo(USED)])
  })

  // A repeated address in a batch large enough for the Koios provider to split by body size lands
  // the same address in two separate request chunks, and each chunk brings its UTxOs back, so the
  // endpoint returned duplicates for a set it promised to answer once. The route deduplicates the
  // validated set first, preserving first-seen order, so the provider is only ever asked about a
  // given address once no matter how the caller repeats it.
  it('deduplicates repeated addresses across chunk boundaries before the provider', async () => {
    let seen: string[] = []
    app = await buildServer({
      provider: fakeProvider({
        getUtxosByAddresses: async (addresses) => {
          seen = addresses
          return addresses.map(utxo)
        },
      }),
    })

    // 600 entries, alternating two distinct addresses: far more than fit in one Koios request
    // body, so without deduplication the repeats would straddle a chunk boundary.
    const repeated = Array.from({ length: 600 }, (_, i) => (i % 2 === 0 ? BYRON_ICARUS : USED))
    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/utxos',
      payload: { addresses: repeated },
    })

    expect(res.statusCode).toBe(200)
    expect(seen).toEqual([BYRON_ICARUS, USED])
    expect(res.json()).toEqual([utxo(BYRON_ICARUS), utxo(USED)])
  })

  it('rejects a malformed address with 400 before hitting the provider', async () => {
    app = await buildServer({
      provider: fakeProvider({
        getUtxosByAddresses: async () => {
          throw new Error('provider should not be called for a malformed address')
        },
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/utxos',
      payload: { addresses: [MALFORMED_BYRON] },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('rejects an empty addresses list with 400', async () => {
    app = await buildServer({ provider: fakeProvider({}) })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/utxos',
      payload: { addresses: [] },
    })

    expect(res.statusCode).toBe(400)
  })

  it('rejects a batch over the address-count cap', async () => {
    app = await buildServer({ provider: fakeProvider({}) })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/utxos',
      payload: { addresses: Array(1001).fill(USED) },
    })

    expect(res.statusCode).toBe(400)
  })

  it('maps a provider error to 502', async () => {
    app = await buildServer({
      provider: fakeProvider({
        getUtxosByAddresses: async () => {
          throw new ProviderError('koios down', { upstreamStatus: 503 })
        },
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/utxos',
      payload: { addresses: [BYRON_ICARUS] },
    })

    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ error: { code: 'UPSTREAM_ERROR' } })
  })
})

describe('POST /v1/addresses/txs', () => {
  const tx = (hash: string): WalletTransaction => ({
    txHash: hash,
    block: 100,
    blockHash: 'b'.repeat(64),
    slot: 1000,
    epoch: 5,
    blockTime: 1_700_000_000,
    fee: '170000',
    inputs: [],
    outputs: [],
    withdrawals: [],
    certificates: [],
  })

  it('returns transactions mapped from the provider for a Byron address', async () => {
    app = await buildServer({
      provider: fakeProvider({
        getTxHistoryByAddresses: async () => [tx('aa')],
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/txs',
      payload: { addresses: [BYRON_DAEDALUS] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([tx('aa')])
  })

  it('passes the after cursor through as a block height', async () => {
    const seen: (number | undefined)[] = []
    app = await buildServer({
      provider: fakeProvider({
        getTxHistoryByAddresses: async (_addresses: string[], afterBlock?: number) => {
          seen.push(afterBlock)
          return []
        },
      }),
    })

    await app.inject({
      method: 'POST',
      url: '/v1/addresses/txs',
      payload: { addresses: [BYRON_ICARUS], after: 12345 },
    })
    await app.inject({
      method: 'POST',
      url: '/v1/addresses/txs',
      payload: { addresses: [BYRON_ICARUS] },
    })

    expect(seen).toEqual([12345, undefined])
  })

  it.each([
    ['a negative cursor', -1],
    ['a non-integer cursor', 1.5],
  ])('rejects %s with 400', async (_case, after) => {
    app = await buildServer({ provider: fakeProvider({}) })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/txs',
      payload: { addresses: [BYRON_ICARUS], after },
    })

    expect(res.statusCode).toBe(400)
  })

  it('rejects a malformed address with 400 before hitting the provider', async () => {
    app = await buildServer({
      provider: fakeProvider({
        getTxHistoryByAddresses: async () => {
          throw new Error('provider should not be called for a malformed address')
        },
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/txs',
      payload: { addresses: [MALFORMED_BYRON] },
    })

    expect(res.statusCode).toBe(400)
  })

  it('rejects an empty addresses list with 400', async () => {
    app = await buildServer({ provider: fakeProvider({}) })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/txs',
      payload: { addresses: [] },
    })

    expect(res.statusCode).toBe(400)
  })

  it('rejects a batch over the address-count cap', async () => {
    app = await buildServer({ provider: fakeProvider({}) })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/txs',
      payload: { addresses: Array(1001).fill(USED) },
    })

    expect(res.statusCode).toBe(400)
  })

  it('maps a provider error to 502', async () => {
    app = await buildServer({
      provider: fakeProvider({
        getTxHistoryByAddresses: async () => {
          throw new ProviderError('koios down', { upstreamStatus: 503 })
        },
      }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/addresses/txs',
      payload: { addresses: [BYRON_ICARUS] },
    })

    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ error: { code: 'UPSTREAM_ERROR' } })
  })
})
