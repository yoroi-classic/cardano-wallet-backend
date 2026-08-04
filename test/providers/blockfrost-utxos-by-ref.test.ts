import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { MalformedUpstreamError, ProviderError } from '../../src/domain/errors.js'

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

/** One `/addresses/{address}/utxos` row, which the membership probe reads by reference alone. */
function held(txHash: string, index: number): Record<string, unknown> {
  return { tx_hash: txHash, output_index: index }
}

/**
 * Answers `/txs/{hash}/utxos` from a per-hash output list; a hash not in the map is a 404.
 *
 * `utxosByAddress` backs the collateral spent-state probe on `/addresses/{address}/utxos`. An
 * address absent from it 404s, meaning Blockfrost has never seen it. The pages are served in the
 * requested `count`/`page` window so a probe that walks more than one page is exercised for real.
 */
function provider(
  byHash: Record<string, Record<string, unknown>[]>,
  utxosByAddress: Record<string, Record<string, unknown>[]> = {},
) {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (rawUrl) => {
    const url = new URL(rawUrl)
    calls.push(url.pathname)

    const addr = url.pathname.match(/\/addresses\/([^/]+)\/utxos$/)
    if (addr !== null) {
      const rows = utxosByAddress[decodeURIComponent(addr[1]!)]
      if (rows === undefined)
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
      const count = Number(url.searchParams.get('count') ?? '100')
      const page = Number(url.searchParams.get('page') ?? '1')
      const ordered = url.searchParams.get('order') === 'desc' ? [...rows].reverse() : rows
      const slice = ordered.slice((page - 1) * count, page * count)
      return { ok: true, status: 200, json: async () => slice, text: async () => '' }
    }

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

  it('surfaces a non-404 upstream failure rather than swallowing it', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => '',
    })
    const p = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(p.getUtxosByRef([`${HASH_A}#0`, `${HASH_B}#0`])).rejects.toBeInstanceOf(
      ProviderError,
    )
  })

  it('throws MalformedUpstreamError when a resolved output has no lovelace unit', async () => {
    const { provider: p } = provider({
      [HASH_A]: [
        output(0, { amount: [{ unit: `${'a'.repeat(56)}6e7574636f696e`, quantity: '5' }] }),
      ],
    })

    await expect(p.getUtxosByRef([`${HASH_A}#0`])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects an output row that omits the collateral flag rather than assuming it', async () => {
    const bare = output(0)
    delete bare['collateral']
    const { provider: p } = provider({ [HASH_A]: [bare] })

    await expect(p.getUtxosByRef([`${HASH_A}#0`])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})

/**
 * Blockfrost documents `consumed_by_tx` as "Always null for collateral outputs", so on a collateral
 * output a null carries no spent-state information. Reading it as unspent is what these pin against:
 * a wallet that offers an already-consumed collateral output builds a transaction the node rejects.
 */
describe('blockfrost getUtxosByRef — collateral outputs', () => {
  const COLLATERAL_ADDR = 'addr_out_0'

  it('reports a consumed collateral output as spent, despite a null consumed_by_tx', async () => {
    // The address holds something, just not this output: it has been consumed since.
    const { provider: p } = provider(
      { [HASH_A]: [output(0, { collateral: true })] },
      { [COLLATERAL_ADDR]: [held(HASH_B, 3)] },
    )

    const [utxo] = await p.getUtxosByRef([`${HASH_A}#0`])

    expect(utxo?.spent).toBe(true)
  })

  it('reports an unconsumed collateral output as unspent when the address still holds it', async () => {
    const { provider: p } = provider(
      { [HASH_A]: [output(0, { collateral: true })] },
      { [COLLATERAL_ADDR]: [held(HASH_B, 3), held(HASH_A, 0)] },
    )

    const [utxo] = await p.getUtxosByRef([`${HASH_A}#0`])

    expect(utxo?.spent).toBe(false)
  })

  it('treats an address Blockfrost has never seen as holding nothing, so the output is spent', async () => {
    const { provider: p } = provider({ [HASH_A]: [output(0, { collateral: true })] }, {})

    const [utxo] = await p.getUtxosByRef([`${HASH_A}#0`])

    expect(utxo?.spent).toBe(true)
  })

  it('matches the reference case-insensitively against the address set', async () => {
    const { provider: p } = provider(
      { [HASH_A]: [output(0, { collateral: true })] },
      { [COLLATERAL_ADDR]: [held(HASH_A.toUpperCase(), 0)] },
    )

    const [utxo] = await p.getUtxosByRef([`${HASH_A}#0`])

    expect(utxo?.spent).toBe(false)
  })

  it('does not confuse a different output index on the same transaction', async () => {
    const { provider: p } = provider(
      { [HASH_A]: [output(0, { collateral: true })] },
      { [COLLATERAL_ADDR]: [held(HASH_A, 1)] },
    )

    const [utxo] = await p.getUtxosByRef([`${HASH_A}#0`])

    expect(utxo?.spent).toBe(true)
  })

  it('walks past the first page to find an output held further down the set', async () => {
    // 150 rows, with the wanted one last. Read newest-first, that puts it on the second page.
    const rows = [held(HASH_A, 0), ...Array.from({ length: 149 }, (_, i) => held(HASH_B, i))]
    const { provider: p, callsTo } = provider(
      { [HASH_A]: [output(0, { collateral: true })] },
      { [COLLATERAL_ADDR]: rows },
    )

    const [utxo] = await p.getUtxosByRef([`${HASH_A}#0`])

    expect(utxo?.spent).toBe(false)
    expect(callsTo(/\/addresses\//)).toBe(2)
  })

  it('stops at the page holding the output rather than walking the whole set', async () => {
    const rows = [...Array.from({ length: 149 }, (_, i) => held(HASH_B, i)), held(HASH_A, 0)]
    const { provider: p, callsTo } = provider(
      { [HASH_A]: [output(0, { collateral: true })] },
      { [COLLATERAL_ADDR]: rows },
    )

    const [utxo] = await p.getUtxosByRef([`${HASH_A}#0`])

    expect(utxo?.spent).toBe(false)
    expect(callsTo(/\/addresses\//)).toBe(1)
  })

  it('honours a consuming transaction hash without probing the address at all', async () => {
    const { provider: p, callsTo } = provider({
      [HASH_A]: [output(0, { collateral: true, consumed_by_tx: HASH_B })],
    })

    const [utxo] = await p.getUtxosByRef([`${HASH_A}#0`])

    expect(utxo?.spent).toBe(true)
    expect(callsTo(/\/addresses\//)).toBe(0)
  })

  it('scans the address once for a reference repeated in the batch', async () => {
    const { provider: p, callsTo } = provider(
      { [HASH_A]: [output(0, { collateral: true })] },
      { [COLLATERAL_ADDR]: [held(HASH_A, 0)] },
    )

    const utxos = await p.getUtxosByRef([`${HASH_A}#0`, `${HASH_A}#0`])

    // Both references still answered, in the caller's order, off one scan.
    expect(utxos.map((u) => u.spent)).toEqual([false, false])
    expect(callsTo(/\/addresses\//)).toBe(1)
  })

  it('scans once per distinct output when one transaction has two collateral references', async () => {
    const { provider: p, callsTo } = provider(
      {
        [HASH_A]: [
          output(0, { collateral: true }),
          output(1, { collateral: true, address: 'addr_out_1' }),
        ],
      },
      { addr_out_0: [held(HASH_A, 0)], addr_out_1: [] },
    )

    const utxos = await p.getUtxosByRef([`${HASH_A}#0`, `${HASH_A}#1`, `${HASH_A}#0`])

    expect(utxos.map((u) => [u.outputIndex, u.spent])).toEqual([
      [0, false],
      [1, true],
      [0, false],
    ])
    expect(callsTo(/\/addresses\//)).toBe(2)
  })

  it('costs an ordinary output no extra request', async () => {
    const { provider: p, callsTo } = provider({ [HASH_A]: [output(0), output(1)] })

    await p.getUtxosByRef([`${HASH_A}#0`, `${HASH_A}#1`])

    expect(callsTo(/\/addresses\//)).toBe(0)
  })

  it('omits an inconclusive reference, keeping the rest of the batch in order', async () => {
    // A page that never shortens and never contains the output, so the walk runs out of budget
    // without an answer. Inconclusive must not surface as unspent, and must not take the ordinary
    // reference alongside it down with it.
    const fetchImpl: FetchLike = async (rawUrl) => {
      const url = new URL(rawUrl)
      if (/\/addresses\//.test(url.pathname)) {
        const rows = Array.from({ length: 100 }, (_, i) => held(HASH_B, i))
        return { ok: true, status: 200, json: async () => rows, text: async () => '' }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          hash: HASH_A,
          inputs: [],
          outputs: [output(0, { collateral: true }), output(1)],
        }),
        text: async () => '',
      }
    }
    const p = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    const utxos = await p.getUtxosByRef([`${HASH_A}#0`, `${HASH_A}#1`])

    expect(utxos.map((u) => u.outputIndex)).toEqual([1])
  })
})
