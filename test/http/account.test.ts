import { afterEach, describe, expect, it } from 'vitest'
import { bech32 } from '@scure/base'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import type { AccountState, Utxo, WalletTransaction } from '../../src/domain/types.js'
import { ProviderError } from '../../src/domain/errors.js'

// A well-formed (valid checksum) preprod stake address for the happy path.
const STAKE = bech32.encode('stake_test', bech32.toWords(new Uint8Array(29)), 1023)

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

function providerWith(overrides: Partial<ChainProvider>): ChainProvider {
  const unused = async () => {
    throw new Error('unused')
  }
  return {
    name: 'fake',
    getTip: unused,
    getProtocolParams: unused,
    filterUsedAddresses: unused,
    getAccountState: async () => structuredClone(STATE),
    getAccountUtxos: async () => structuredClone(UTXOS),
    getTxHistory: async () => [],
    submitTx: unused,
    getTxStatus: unused,
    getPoolInfo: unused,
    getPoolList: unused,
    getTokenMetadata: unused,
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

  it('rejects a stake address with a bad checksum', async () => {
    app = buildServer({ provider: providerWith({}) })
    // Flip the last character to break the bech32 checksum.
    const broken = STAKE.slice(0, -1) + (STAKE.endsWith('q') ? 'p' : 'q')
    const res = await app.inject({ method: 'GET', url: `/v1/account/${broken}/state` })

    expect(res.statusCode).toBe(400)
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
    app = buildServer({ provider: providerWith({ getTxHistory: async () => TXS }) })
    const res = await app.inject({ method: 'GET', url: `/v1/account/${STAKE}/txs` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(TXS)
  })

  it('rejects a non-numeric or empty after with 400', async () => {
    app = buildServer({ provider: providerWith({}) })

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
