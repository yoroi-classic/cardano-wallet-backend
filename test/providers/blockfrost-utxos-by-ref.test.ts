import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { MalformedUpstreamError } from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function output(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: `addr_out_${index}`,
    amount: [{ unit: 'lovelace', quantity: `${(index + 1) * 1000000}` }],
    output_index: index,
    data_hash: null,
    inline_datum: null,
    collateral: false,
    reference_script_hash: null,
    consumed_by_tx: null,
    ...overrides,
  }
}

/** Answers `/txs/{hash}/utxos` from a per-hash output list; a hash not in the map is a 404. */
function provider(byHash: Record<string, Record<string, unknown>[]>) {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (rawUrl) => {
    const url = new URL(rawUrl)
    calls.push(url.pathname)
    const m = url.pathname.match(/\/txs\/([^/]+)\/utxos$/)
    if (m === null) throw new Error(`fake has no route for ${url.pathname}`)
    const outputs = byHash[m[1]!]
    if (outputs === undefined)
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
    return {
      ok: true,
      status: 200,
      json: async () => ({ hash: m[1], inputs: [], outputs }),
      text: async () => '',
    }
  }
  return {
    provider: createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl }),
    callsTo: (re: RegExp) => calls.filter((c) => re.test(c)).length,
  }
}

describe('blockfrost getUtxosByRef', () => {
  it('resolves an output by reference, reporting it unspent', async () => {
    const { provider: p } = provider({
      [HASH_A]: [
        output(0),
        output(1, {
          amount: [
            { unit: 'lovelace', quantity: '4800000' },
            { unit: `${'d'.repeat(56)}4142`, quantity: '3' },
          ],
          inline_datum: 'd87980',
          reference_script_hash: 'ee'.repeat(28),
        }),
      ],
    })

    const utxos = await p.getUtxosByRef([`${HASH_A}#1`])

    expect(utxos).toEqual([
      {
        txHash: HASH_A,
        outputIndex: 1,
        address: 'addr_out_1',
        value: '4800000',
        assets: [{ policyId: 'd'.repeat(56), assetName: '4142', quantity: '3' }],
        inlineDatum: 'd87980',
        referenceScriptHash: 'ee'.repeat(28),
        spent: false,
      },
    ])
  })

  it('reports a consumed output as spent', async () => {
    const { provider: p } = provider({ [HASH_A]: [output(0, { consumed_by_tx: HASH_B })] })

    const [utxo] = await p.getUtxosByRef([`${HASH_A}#0`])

    expect(utxo?.spent).toBe(true)
  })

  it('reads each transaction once even when several references share it', async () => {
    const { provider: p, callsTo } = provider({ [HASH_A]: [output(0), output(1)] })

    const utxos = await p.getUtxosByRef([`${HASH_A}#0`, `${HASH_A}#1`])

    expect(utxos.map((u) => u.outputIndex)).toEqual([0, 1])
    expect(callsTo(/\/txs\//)).toBe(1)
  })

  it('omits a reference whose transaction is not on chain, keeping the rest in order', async () => {
    const { provider: p } = provider({ [HASH_A]: [output(0)] })

    const utxos = await p.getUtxosByRef([`${HASH_B}#0`, `${HASH_A}#0`])

    expect(utxos.map((u) => u.txHash)).toEqual([HASH_A])
  })

  it('omits a reference whose output index does not exist in the transaction', async () => {
    const { provider: p } = provider({ [HASH_A]: [output(0)] })

    await expect(p.getUtxosByRef([`${HASH_A}#9`])).resolves.toEqual([])
  })

  it('drops a malformed reference rather than failing the batch', async () => {
    const { provider: p } = provider({ [HASH_A]: [output(0)] })

    const utxos = await p.getUtxosByRef(['not-a-ref', `${HASH_A}#0`])

    expect(utxos.map((u) => u.txHash)).toEqual([HASH_A])
  })

  it('returns an empty array without any request for an empty input', async () => {
    let called = false
    const fetchImpl: FetchLike = async () => {
      called = true
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
    const p = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(p.getUtxosByRef([])).resolves.toEqual([])
    expect(called).toBe(false)
  })

  it('throws MalformedUpstreamError when a resolved output has no lovelace unit', async () => {
    const { provider: p } = provider({
      [HASH_A]: [
        output(0, { amount: [{ unit: `${'a'.repeat(56)}6e7574636f696e`, quantity: '5' }] }),
      ],
    })

    await expect(p.getUtxosByRef([`${HASH_A}#0`])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})
