import { afterEach, describe, expect, it } from 'vitest'
import { bech32 } from '@scure/base'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import type { AccountState } from '../../src/domain/types/account.js'
import type { Utxo, WalletTransaction } from '../../src/domain/types/transactions.js'
import { ProviderError } from '../../src/domain/errors.js'
import { fakeProvider } from '../support/fake-provider.js'

const stakeAddress = (prefix: 'stake' | 'stake_test', header: number, length = 29) => {
  const bytes = new Uint8Array(length)
  bytes[0] = header
  return bech32.encode(prefix, bech32.toWords(bytes), 1023)
}

// A reward key-hash address on preprod: type 14 and network id 0.
const STAKE = stakeAddress('stake_test', 0xe0)

const STATE: AccountState = {
  stakeAddress: STAKE,
  registered: true,
  balance: '1000000',
  rewardsAvailable: '0',
  rewardsSum: '0',
  withdrawalsSum: '0',
}

const UTXOS: Utxo[] = [
  { txHash: 'aa', outputIndex: 0, address: 'addr_test1', value: '2000000', assets: [] },
]

function providerWith(overrides: Partial<ChainProvider> = {}): ChainProvider {
  return fakeProvider({
    getAccountState: async () => structuredClone(STATE),
    getAccountUtxos: async () => structuredClone(UTXOS),
    getTxHistory: async () => [],
    ...overrides,
  })
}

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

describe('account routes', () => {
  it('GET /v1/account/:stake/state returns account state', async () => {
    app = await buildServer({ provider: providerWith({}) })
    const res = await app.inject({ method: 'GET', url: `/v1/account/${STAKE}/state` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(STATE)
  })

  it('GET /v1/account/:stake/utxos returns utxos', async () => {
    app = await buildServer({ provider: providerWith({}) })
    const res = await app.inject({ method: 'GET', url: `/v1/account/${STAKE}/utxos` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(UTXOS)
  })

  it('rejects an invalid stake address with 400 and never calls the provider', async () => {
    let called = false
    app = await buildServer({
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

  it('rejects a stake address with a bad checksum', async () => {
    app = await buildServer({ provider: providerWith({}) })
    // Flip the last character to break the bech32 checksum.
    const broken = STAKE.slice(0, -1) + (STAKE.endsWith('q') ? 'p' : 'q')
    const res = await app.inject({ method: 'GET', url: `/v1/account/${broken}/state` })

    expect(res.statusCode).toBe(400)
  })

  it.each([
    ['a payment-address header', 'preprod', stakeAddress('stake_test', 0x00)],
    ['a 28-byte payload', 'preprod', stakeAddress('stake_test', 0xe0, 28)],
    ['a 30-byte payload', 'preprod', stakeAddress('stake_test', 0xe0, 30)],
    [
      'invalid 5-bit padding',
      'preprod',
      bech32.encode(
        'stake_test',
        [...bech32.toWords(new Uint8Array([0xe0, ...new Uint8Array(28)])), 31],
        1023,
      ),
    ],
    [
      'a non-stake HRP',
      'preprod',
      bech32.encode(
        'addr_test',
        bech32.toWords(new Uint8Array([0xe0, ...new Uint8Array(28)])),
        1023,
      ),
    ],
    ['a mainnet HRP with a testnet header', 'preprod', stakeAddress('stake', 0xe0)],
    ['a testnet HRP with a mainnet header', 'preprod', stakeAddress('stake_test', 0xe1)],
    ['a mainnet address on preprod', 'preprod', stakeAddress('stake', 0xe1)],
    ['a testnet address on mainnet', 'mainnet', stakeAddress('stake_test', 0xe0)],
  ])(
    'rejects %s on every account route without an upstream call',
    async (_case, network, invalid) => {
      const calls: string[] = []
      app = await buildServer({
        provider: providerWith({
          getAccountState: async () => {
            calls.push('state')
            return structuredClone(STATE)
          },
          getAccountUtxos: async () => {
            calls.push('utxos')
            return []
          },
          getTxHistory: async () => {
            calls.push('txs')
            return []
          },
          getRewardHistory: async () => {
            calls.push('rewards')
            return []
          },
        }),
        info: { version: 'test', network, provider: 'fake' },
      })

      for (const suffix of ['state', 'utxos', 'txs', 'rewards']) {
        const res = await app.inject({ method: 'GET', url: `/v1/account/${invalid}/${suffix}` })
        expect(res.statusCode).toBe(400)
        expect(res.json()).toEqual({
          error: { code: 'BAD_REQUEST', message: 'invalid stake address' },
        })
      }
      expect(calls).toEqual([])
    },
  )

  it.each([
    ['a testnet reward key address', 'preprod', stakeAddress('stake_test', 0xe0)],
    ['a testnet reward script address', 'preview', stakeAddress('stake_test', 0xf0)],
    ['a mainnet reward key address', 'mainnet', stakeAddress('stake', 0xe1)],
    ['a mainnet reward script address', 'mainnet', stakeAddress('stake', 0xf1)],
  ])('accepts %s on the configured network', async (_case, network, stake) => {
    const seen: string[] = []
    app = await buildServer({
      provider: providerWith({
        getAccountState: async (value) => {
          seen.push(value)
          return { ...structuredClone(STATE), stakeAddress: value }
        },
      }),
      info: { version: 'test', network, provider: 'fake' },
    })

    const res = await app.inject({ method: 'GET', url: `/v1/account/${stake}/state` })

    expect(res.statusCode).toBe(200)
    expect(seen).toEqual([stake])
  })

  it('maps a provider error to 502', async () => {
    app = await buildServer({
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

  it('GET /v1/account/:stake/txs returns transaction history', async () => {
    const TXS: WalletTransaction[] = [
      {
        txHash: 'aa',
        block: 1,
        blockHash: 'bb',
        slot: 2,
        epoch: 3,
        blockTime: 4,
        fee: '170000',
        inputs: [],
        outputs: [],
        withdrawals: [],
        certificates: [],
      },
    ]
    app = await buildServer({ provider: providerWith({ getTxHistory: async () => TXS }) })
    const res = await app.inject({ method: 'GET', url: `/v1/account/${STAKE}/txs` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(TXS)
  })

  it('rejects a non-numeric or empty after with 400', async () => {
    app = await buildServer({ provider: providerWith({}) })

    const nonNumeric = await app.inject({
      method: 'GET',
      url: `/v1/account/${STAKE}/txs?after=abc`,
    })
    expect(nonNumeric.statusCode).toBe(400)
    expect(nonNumeric.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })

    const empty = await app.inject({ method: 'GET', url: `/v1/account/${STAKE}/txs?after=` })
    expect(empty.statusCode).toBe(400)

    const huge = await app.inject({
      method: 'GET',
      url: `/v1/account/${STAKE}/txs?after=999999999999999999999`,
    })
    expect(huge.statusCode).toBe(400)
  })
})
