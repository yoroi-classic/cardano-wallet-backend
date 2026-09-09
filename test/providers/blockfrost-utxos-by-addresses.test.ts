import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { MalformedUpstreamError } from '../../src/domain/errors.js'

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

// The height every `/blocks/{hash}` lookup answers with unless a test overrides it. Blockfrost
// puts no height on a utxo row, so the driver resolves the row's `block` hash through this route.
const DEFAULT_BLOCK_HEIGHT = 10_000_000

/**
 * Paginates `/addresses/{address}/utxos` per address, 404 for any address not in the map, and
 * answers `/blocks/{hash}` with the height for that hash (or the default).
 */
function provider(
  byAddress: Record<string, Record<string, unknown>[] | { status: number }>,
  opts: Record<string, unknown> = {},
  blockHeights: Record<string, number> = {},
) {
  const fetchImpl: FetchLike = async (rawUrl) => {
    const url = new URL(rawUrl)
    const block = url.pathname.match(/\/blocks\/([^/]+)$/)
    if (block !== null) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ height: blockHeights[block[1]!] ?? DEFAULT_BLOCK_HEIGHT }),
        text: async () => '',
      }
    }
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
  // Blockfrost puts only the creation block's *hash* on a utxo row, so unlike Koios it cannot
  // read the height off the row. These cover the resolution that closes that gap.
  it("resolves each row's creation height from its own block", async () => {
    const blockA = 'a'.repeat(64)
    const blockB = 'b'.repeat(64)
    const p = provider(
      {
        addr_a: [
          utxo({ address: 'addr_a', output_index: 0, block: blockA }),
          utxo({ address: 'addr_a', output_index: 1, block: blockB }),
        ],
      },
      {},
      { [blockA]: 4_961_506, [blockB]: 5_153_923 },
    )

    const utxos = await p.getUtxosByAddresses(['addr_a'])

    expect(utxos.map((u) => u.blockHeight)).toEqual([4_961_506, 5_153_923])
  })

  // The cost of this provider's extra round trip is bounded by the number of distinct blocks, not
  // the number of outputs. Change from one transaction lands in one block, which is the common case.
  it('resolves one block once however many of its outputs are held', async () => {
    const shared = 'c'.repeat(64)
    const seen: string[] = []
    const fetchImpl: FetchLike = async (rawUrl) => {
      const url = new URL(rawUrl)
      if (url.pathname.includes('/blocks/')) {
        seen.push(url.pathname)
        return { ok: true, status: 200, json: async () => ({ height: 42 }), text: async () => '' }
      }
      const page = Number(url.searchParams.get('page') ?? '1')
      const rows =
        page === 1
          ? Array.from({ length: 3 }, (_v, i) =>
              utxo({ address: 'addr_a', output_index: i, block: shared }),
            )
          : []
      return { ok: true, status: 200, json: async () => rows, text: async () => '' }
    }
    const p = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    const utxos = await p.getUtxosByAddresses(['addr_a'])

    expect(utxos.map((u) => u.blockHeight)).toEqual([42, 42, 42])
    expect(seen).toHaveLength(1)
  })

  // A Byron epoch-boundary block has a null height in the spec. It contains no transactions, so it
  // can never have created a UTxO; reading one here is malformed upstream data, not a case to map
  // around by omitting the field.
  it('rejects a creation block that reports no height', async () => {
    const fetchImpl: FetchLike = async (rawUrl) => {
      const url = new URL(rawUrl)
      if (url.pathname.includes('/blocks/')) {
        return { ok: true, status: 200, json: async () => ({ height: null }), text: async () => '' }
      }
      const page = Number(url.searchParams.get('page') ?? '1')
      return {
        ok: true,
        status: 200,
        json: async () => (page === 1 ? [utxo({ address: 'addr_a' })] : []),
        text: async () => '',
      }
    }
    const p = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(p.getUtxosByAddresses(['addr_a'])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

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
        blockHeight: DEFAULT_BLOCK_HEIGHT,
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

  it('pages through a legitimately large address rather than failing at a wallet-sized cap', async () => {
    // 6,000 UTxOs across 60 full pages, then a short page: an exchange- or script-sized address that
    // the old 5,000-UTxO cap would have rejected. It must return the whole set.
    const total = 6000
    const fetchImpl: FetchLike = async (rawUrl) => {
      const url = new URL(rawUrl)
      if (/\/blocks\//.test(url.pathname)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ height: DEFAULT_BLOCK_HEIGHT }),
          text: async () => '',
        }
      }
      const count = Number(url.searchParams.get('count') ?? '100')
      const pageNo = Number(url.searchParams.get('page') ?? '1')
      const offset = (pageNo - 1) * count
      const rows = Array.from({ length: Math.max(0, Math.min(count, total - offset)) }, (_v, i) =>
        utxo({ address: 'addr_a', tx_hash: `${offset + i}`.padStart(64, '0') }),
      )
      return { ok: true, status: 200, json: async () => rows, text: async () => '' }
    }
    const p = createBlockfrostProvider({
      baseUrl: BASE,
      projectId: PROJECT_ID,
      fetchImpl,
      burstSize: 100000,
    })

    const utxos = await p.getUtxosByAddresses(['addr_a'])

    expect(utxos).toHaveLength(total)
  })
})
