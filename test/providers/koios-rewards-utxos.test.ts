import { describe, expect, it } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'
import { MalformedUpstreamError } from '../../src/domain/errors.js'

const BASE = 'https://preprod.koios.rest/api/v1'
const STAKE = 'stake_test1upxue2rk4tp0e3tp7l0nmfmj6ar7y9yvngzu0vn7fxs9ags2apttt'
const TX = 'a'.repeat(64)
const TX_2 = 'b'.repeat(64)
const POOL = 'pool1mp96jpc2dtaruz0cazmljh03dev0969c4rq3wr6hnc4rjdxn8aw'

interface Call {
  url: string
  body?: string | Uint8Array
}

function fakeFetch(json: () => Promise<unknown>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body })
    return { ok: true, status: 200, json, text: async () => '' }
  }
  return { fetchImpl, calls }
}

/** Shaped after a live Koios /account_rewards row. */
const reward = (earned: number, amount: string, type = 'member', pool: string | null = POOL) => ({
  earned_epoch: earned,
  spendable_epoch: earned + 2,
  amount,
  type,
  pool_id: pool,
})

describe('koios getRewardHistory', () => {
  it('maps a reward and orders the history oldest first', async () => {
    // Deliberately out of order: Koios promises no ordering here, and a graph drawn from an
    // unordered series is a scribble.
    const rows = [
      { stake_address: STAKE, rewards: [reward(32, '453410944'), reward(30, '390098844')] },
    ]
    const { fetchImpl } = fakeFetch(async () => rows)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const history = await provider.getRewardHistory(STAKE)

    expect(history).toEqual([
      {
        earnedEpoch: 30,
        spendableEpoch: 32,
        amount: '390098844',
        kind: 'member',
        poolId: POOL,
      },
      {
        earnedEpoch: 32,
        spendableEpoch: 34,
        amount: '453410944',
        kind: 'member',
        poolId: POOL,
      },
    ])
  })

  // Cardano pays two epochs in arrears, so `earned` and `spendable` differ by ten days. Paging on
  // the wrong one shifts every point on the graph by that much and still looks plausible.
  it('pages on the earned epoch, not the spendable one', async () => {
    const rows = [
      {
        stake_address: STAKE,
        rewards: [reward(30, '1'), reward(31, '2'), reward(32, '3')],
      },
    ]
    const { fetchImpl } = fakeFetch(async () => rows)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const history = await provider.getRewardHistory(STAKE, 31)

    // Epoch 31 was earned at 31 and spendable at 33. Paging after 31 must exclude it, and must
    // not accidentally include epoch 30 (whose *spendable* epoch is 32, which is > 31).
    expect(history.map((r) => r.earnedEpoch)).toEqual([32])
  })

  it('leaves poolId absent for a reward that no pool paid', async () => {
    const rows = [
      {
        stake_address: STAKE,
        rewards: [
          reward(30, '500', 'treasury', null),
          reward(31, '600', 'reserves', null),
          reward(32, '2000000', 'refund', null),
        ],
      },
    ]
    const { fetchImpl } = fakeFetch(async () => rows)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const history = await provider.getRewardHistory(STAKE)

    expect(history.map((r) => r.kind)).toEqual(['treasury', 'reserves', 'refund'])
    for (const entry of history) {
      expect(entry.poolId).toBeUndefined()
      // Absent, not an empty string: an empty pool id is a pool id that does not exist.
      expect(JSON.parse(JSON.stringify(entry))).not.toHaveProperty('poolId')
    }
  })

  // A pool operator earns both a member share and a leader cut in the same epoch, from the same
  // pool. The history is a list, not a map keyed by epoch, precisely so both survive.
  it('keeps two rewards earned in the same epoch', async () => {
    const rows = [
      {
        stake_address: STAKE,
        rewards: [reward(30, '100', 'member'), reward(30, '900', 'leader')],
      },
    ]
    const { fetchImpl } = fakeFetch(async () => rows)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const history = await provider.getRewardHistory(STAKE)

    expect(history).toHaveLength(2)
    expect(history.map((r) => r.kind).sort()).toEqual(['leader', 'member'])
  })

  it.each([
    ['an account with no rewards', [{ stake_address: STAKE, rewards: [] }]],
    ['an account Koios reports with a null list', [{ stake_address: STAKE, rewards: null }]],
    ['an account Koios does not know at all', []],
  ])('returns an empty history for %s, rather than an error', async (_case, rows) => {
    const { fetchImpl } = fakeFetch(async () => rows)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getRewardHistory(STAKE)).resolves.toEqual([])
  })

  it('rejects a reward kind that is not in the spec', async () => {
    const rows = [{ stake_address: STAKE, rewards: [reward(30, '1', 'bribe')] }]
    const { fetchImpl } = fakeFetch(async () => rows)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getRewardHistory(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})

describe('koios getUtxosByRef', () => {
  const utxo = (hash: string, index: number, spent: boolean) => ({
    tx_hash: hash,
    tx_index: index,
    address: 'addr_test1qz09v9yfxguvlp0zsnrpa3tdtm7el8xufp3m5lsm7qxzcl',
    value: '1000000000000',
    asset_list: [{ policy_id: 'c'.repeat(56), asset_name: '414243', quantity: '5' }],
    datum_hash: null,
    inline_datum: { bytes: 'd87980' },
    reference_script: null,
    is_spent: spent,
  })

  it('resolves an output and reports its assets and datum', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [utxo(TX, 0, false)])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [resolved] = await provider.getUtxosByRef([`${TX}#0`])

    expect(resolved).toEqual({
      txHash: TX,
      outputIndex: 0,
      address: 'addr_test1qz09v9yfxguvlp0zsnrpa3tdtm7el8xufp3m5lsm7qxzcl',
      value: '1000000000000',
      assets: [{ policyId: 'c'.repeat(56), assetName: '414243', quantity: '5' }],
      inlineDatum: 'd87980',
      spent: false,
    })
    // _extended is what makes Koios return the assets and the datum at all. Without it a dApp
    // connector resolving an input would see a bare lovelace value and none of the tokens on it.
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({ _extended: true })
  })

  // The field the endpoint exists for. A wallet that offers a spent output as collateral builds a
  // transaction the node rejects, and the user sees a failure with no explanation.
  it('reports a spent output as spent, rather than omitting it', async () => {
    const { fetchImpl } = fakeFetch(async () => [utxo(TX, 0, true)])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [resolved] = await provider.getUtxosByRef([`${TX}#0`])

    expect(resolved?.spent).toBe(true)
  })

  it('returns results in the caller order and omits references that are not on chain', async () => {
    const { fetchImpl } = fakeFetch(async () => [utxo(TX_2, 1, false), utxo(TX, 0, false)])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const resolved = await provider.getUtxosByRef([
      `${TX}#0`,
      `${'f'.repeat(64)}#9`, // never existed
      `${TX_2}#1`,
    ])

    expect(resolved.map((u) => `${u.txHash}#${u.outputIndex}`)).toEqual([`${TX}#0`, `${TX_2}#1`])
  })

  it('preserves repeated canonical references in the request and result order', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [utxo(TX, 1, false)])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const resolved = await provider.getUtxosByRef([`${TX}#1`, `${TX}#1`])

    expect(JSON.parse(String(calls[0]?.body))._utxo_refs).toEqual([`${TX}#1`, `${TX}#1`])
    expect(resolved.map((u) => `${u.txHash}#${u.outputIndex}`)).toEqual([`${TX}#1`, `${TX}#1`])
  })

  it('returns [] without calling upstream for an empty batch', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getUtxosByRef([])).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })

  // Not defaulted. Reading a missing is_spent as "unspent" would be guessing, in the direction
  // that breaks a transaction.
  it('rejects a row with no spent flag rather than assuming unspent', async () => {
    const { fetchImpl } = fakeFetch(async () => {
      const row: Record<string, unknown> = utxo(TX, 0, false)
      delete row.is_spent
      return [row]
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getUtxosByRef([`${TX}#0`])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})
