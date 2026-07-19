import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { MalformedUpstreamError, ProviderError } from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'

function utxo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: 'addr_default',
    tx_hash: '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
    tx_index: 0,
    output_index: 0,
    amount: [{ unit: 'lovelace', quantity: '42000000' }],
    block: '7eb8e27d18686c7db9a18f8bbcfe34e3fed6e047afaa2d969904d15e934847e6',
    data_hash: null,
    inline_datum: null,
    reference_script_hash: null,
    ...overrides,
  }
}

/** Paginates `/addresses/{address}/utxos` per address, 404 for any address not in the map. */
function provider(
  byAddress: Record<string, Record<string, unknown>[] | { status: number }>,
  opts: Record<string, unknown> = {},
) {
  const fetchImpl: FetchLike = async (rawUrl) => {
    const url = new URL(rawUrl)
    const m = url.pathname.match(/\/addresses\/([^/]+)\/utxos$/)
    if (m === null) throw new Error(`fake has no route for ${url.pathname}`)
    const rows = byAddress[m[1]!]
    if (rows === undefined) throw new Error(`no fixture for ${m[1]}`)
    if (!Array.isArray(rows)) {
      return {
        ok: rows.status < 400,
        status: rows.status,
        json: async () => ({}),
        text: async () => '',
      }
    }
    const count = Number(url.searchParams.get('count') ?? '100')
    const page = Number(url.searchParams.get('page') ?? '1')
    return {
      ok: true,
      status: 200,
      json: async () => rows.slice((page - 1) * count, page * count),
      text: async () => '',
    }
  }
  return createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl, ...opts })
}

describe('blockfrost getUtxosByAddresses', () => {
  it('maps a utxo, splitting lovelace from native assets, and carries datum/reference-script fields', async () => {
    const policyId = 'c'.repeat(56)
    const assetName = '6e7574636f696e'
    const p = provider({
      addr_a: [
        utxo({
          address: 'addr_a',
          output_index: 1,
          amount: [
            { unit: 'lovelace', quantity: '42000000' },
            { unit: `${policyId}${assetName}`, quantity: '12' },
          ],
          data_hash: 'aa'.repeat(16),
          inline_datum: 'd8799f00ff',
          reference_script_hash: 'bb'.repeat(28),
        }),
      ],
    })

    const utxos = await p.getUtxosByAddresses(['addr_a'])

    expect(utxos).toEqual([
      {
        txHash: '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
        outputIndex: 1,
        address: 'addr_a',
        value: '42000000',
        assets: [{ policyId, assetName, quantity: '12' }],
        datumHash: 'aa'.repeat(16),
        inlineDatum: 'd8799f00ff',
        referenceScriptHash: 'bb'.repeat(28),
      },
    ])
  })

  it('merges utxos across addresses in the caller order, and skips a never-used address', async () => {
    const p = provider({
      addr_a: [utxo({ address: 'addr_a', tx_hash: 'a'.repeat(64) })],
      addr_unused: { status: 404 },
      addr_b: [utxo({ address: 'addr_b', tx_hash: 'b'.repeat(64) })],
    })

    const utxos = await p.getUtxosByAddresses(['addr_a', 'addr_unused', 'addr_b'])

    expect(utxos.map((u) => u.address)).toEqual(['addr_a', 'addr_b'])
  })

  it('pages a single address until a short page ends the walk', async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      utxo({ address: 'addr_a', tx_hash: `${i}`.padStart(64, '0') }),
    )
    const short = [utxo({ address: 'addr_a', tx_hash: 'f'.repeat(64), output_index: 7 })]
    const p = provider({ addr_a: [...full, ...short] })

    const utxos = await p.getUtxosByAddresses(['addr_a'])

    expect(utxos).toHaveLength(101)
    expect(utxos[100]?.outputIndex).toBe(7)
  })

  it('falls back to the queried address when a row omits its own', async () => {
    const row = utxo()
    delete row.address
    const p = provider({ addr_a: [row] })

    const utxos = await p.getUtxosByAddresses(['addr_a'])

    expect(utxos[0]?.address).toBe('addr_a')
  })

  it('returns an empty array without any request for an empty input', async () => {
    let called = false
    const fetchImpl: FetchLike = async () => {
      called = true
      return { ok: true, status: 200, json: async () => [], text: async () => '' }
    }
    const p = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(p.getUtxosByAddresses([])).resolves.toEqual([])
    expect(called).toBe(false)
  })

  it('throws MalformedUpstreamError on a utxo amount with no lovelace unit', async () => {
    const p = provider({
      addr_a: [
        utxo({
          address: 'addr_a',
          amount: [{ unit: `${'a'.repeat(56)}6e7574636f696e`, quantity: '5' }],
        }),
      ],
    })

    await expect(p.getUtxosByAddresses(['addr_a'])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects an address holding more utxos than the scan bound', async () => {
    // A fake that never returns a short page: every page is full, so the walk hits its bound and the
    // boundary probe still finds more.
    const fetchImpl: FetchLike = async (rawUrl) => {
      const url = new URL(rawUrl)
      const count = Number(url.searchParams.get('count') ?? '100')
      const rows = Array.from({ length: count }, (_, i) =>
        utxo({ address: 'addr_a', tx_hash: `${i}`.padStart(64, '0') }),
      )
      return { ok: true, status: 200, json: async () => rows, text: async () => '' }
    }
    const p = createBlockfrostProvider({
      baseUrl: BASE,
      projectId: PROJECT_ID,
      fetchImpl,
      burstSize: 100000,
    })

    await expect(p.getUtxosByAddresses(['addr_a'])).rejects.toBeInstanceOf(ProviderError)
  })
})
