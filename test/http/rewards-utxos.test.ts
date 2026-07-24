import { bech32 } from '@scure/base'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../../src/http/server.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import { fakeProvider } from '../support/fake-provider.js'

const STAKE = bech32.encode('stake_test', bech32.toWords(new Uint8Array(29)), 1023)
const TX = 'a'.repeat(64)

const serve = async (overrides: Partial<ChainProvider>) =>
  buildServer({ provider: fakeProvider(overrides) })

describe('GET /v1/account/{stake}/rewards', () => {
  it('returns the reward history', async () => {
    const app = await serve({
      getRewardHistory: async () => [
        { earnedEpoch: 30, spendableEpoch: 32, amount: '390098844', kind: 'member', poolId: 'p' },
      ],
    })

    const res = await app.inject({ method: 'GET', url: `/v1/account/${STAKE}/rewards` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      { earnedEpoch: 30, spendableEpoch: 32, amount: '390098844', kind: 'member', poolId: 'p' },
    ])
    await app.close()
  })

  it('passes the after cursor through as an epoch', async () => {
    const seen: (number | undefined)[] = []
    const app = await serve({
      getRewardHistory: async (_stake: string, afterEpoch?: number) => {
        seen.push(afterEpoch)
        return []
      },
    })

    await app.inject({ method: 'GET', url: `/v1/account/${STAKE}/rewards?after=42` })
    await app.inject({ method: 'GET', url: `/v1/account/${STAKE}/rewards` })

    expect(seen).toEqual([42, undefined])
    await app.close()
  })

  it.each([
    ['a non-numeric cursor', 'after=soon'],
    ['an empty cursor', 'after='],
    ['a negative cursor', 'after=-1'],
  ])('rejects %s', async (_case, query) => {
    const app = await serve({ getRewardHistory: async () => [] })

    const res = await app.inject({ method: 'GET', url: `/v1/account/${STAKE}/rewards?${query}` })

    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('rejects a stake address that is not one', async () => {
    const app = await serve({ getRewardHistory: async () => [] })

    const res = await app.inject({ method: 'GET', url: '/v1/account/not-a-stake-key/rewards' })

    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('POST /v1/tx/utxos', () => {
  const utxo = (spent: boolean) => ({
    txHash: TX,
    outputIndex: 0,
    address: 'addr_test1x',
    value: '2000000',
    assets: [],
    spent,
  })

  it('resolves references and says whether each output is still there', async () => {
    const app = await serve({ getUtxosByRef: async () => [utxo(true)] })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tx/utxos',
      payload: { refs: [`${TX}#0`] },
    })

    expect(res.statusCode).toBe(200)
    // The whole reason this endpoint exists. Collateral must be unspent; a wallet that reuses a
    // spent output builds a transaction the node rejects, and the user sees no explanation.
    expect(res.json()[0].spent).toBe(true)
    await app.close()
  })

  it('canonicalizes hash case and leading-zero indices without deduplicating references', async () => {
    const seen: string[][] = []
    const app = await serve({
      getUtxosByRef: async (refs: string[]) => {
        seen.push(refs)
        return []
      },
    })

    await app.inject({
      method: 'POST',
      url: '/v1/tx/utxos',
      payload: {
        refs: [`${'A'.repeat(64)}#00001`, `${TX}#1`, `${TX}#00000`, `${TX}#0`],
      },
    })

    expect(seen[0]).toEqual([`${TX}#1`, `${TX}#1`, `${TX}#0`, `${TX}#0`])
    await app.close()
  })

  it('accepts the maximum bounded output index', async () => {
    const seen: string[][] = []
    const app = await serve({
      getUtxosByRef: async (refs: string[]) => {
        seen.push(refs)
        return []
      },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tx/utxos',
      payload: { refs: [`${TX}#65535`] },
    })

    expect(res.statusCode).toBe(200)
    expect(seen[0]).toEqual([`${TX}#65535`])
    await app.close()
  })

  it.each([
    ['a hash that is too short', 'abc#0'],
    ['a missing index', `${TX}`],
    ['a non-numeric index', `${TX}#x`],
    ['a negative index', `${TX}#-1`],
    ['a signed index', `${TX}#+1`],
    ['a decimal index', `${TX}#1.0`],
    ['an index above the protocol bound', `${TX}#65536`],
    ['an unsafe integer index', `${TX}#9007199254740992`],
    ['an extremely long index', `${TX}#${'9'.repeat(1_000)}`],
    ['a second separator', `${TX}#1#0`],
    ['a hash that is not hex', `${'z'.repeat(64)}#0`],
  ])('rejects %s', async (_case, ref) => {
    const app = await serve({ getUtxosByRef: async () => [] })

    const res = await app.inject({ method: 'POST', url: '/v1/tx/utxos', payload: { refs: [ref] } })

    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it.each([
    ['an empty batch', { refs: [] }],
    ['an oversized batch', { refs: Array(101).fill(`${TX}#0`) }],
    ['a body that is not the right shape', { utxos: [`${TX}#0`] }],
  ])('rejects %s', async (_case, payload) => {
    const app = await serve({ getUtxosByRef: async () => [] })

    const res = await app.inject({ method: 'POST', url: '/v1/tx/utxos', payload })

    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
