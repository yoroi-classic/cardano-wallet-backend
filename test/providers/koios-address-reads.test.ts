import { describe, expect, it } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'
import { MalformedUpstreamError, ProviderError } from '../../src/domain/errors.js'

const BASE = 'https://preprod.koios.rest/api/v1'

// Real, live-verified Byron addresses (see test/domain/byron-address.test.ts for the source of
// each), used here to lock the regression that these routes exist to serve: Byron has no stake
// key, so these calls are how a Byron wallet reads its UTxOs and history at all.
const BYRON_A = 'Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi'
const BYRON_B =
  'DdzFFzCqrht9W56zJGEFvHHywdeXZiGVYGqVhoZj6SRrS9o2HNLmorEzZhKm7khqfBKvCaTKGLtTnQSToxuvdzJTkQqcAf6f2ErxbSKS'

interface Call {
  url: string
  method?: string
  body?: string | Uint8Array
  headers?: Record<string, string>
}

function fakeFetch(json: () => Promise<unknown>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body, headers: init?.headers })
    return { ok: true, status: 200, json, text: async () => '' }
  }
  return { fetchImpl, calls }
}

// getTxHistoryByAddresses makes two calls (address_txs then tx_info), so route the fake by path,
// same pattern koios-account.test.ts uses for getTxHistory.
function fakeFetchByPath(responses: Record<string, unknown>): {
  fetchImpl: FetchLike
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body, headers: init?.headers })
    const key = Object.keys(responses).find((k) => url.includes(k))
    const data = key !== undefined ? responses[key] : []
    return { ok: true, status: 200, json: async () => data, text: async () => '' }
  }
  return { fetchImpl, calls }
}

describe('koios getUtxosByAddresses', () => {
  const ROW = {
    tx_hash: 'aa11',
    tx_index: 2,
    address: BYRON_A,
    value: '2000000',
    asset_list: [{ policy_id: 'a'.repeat(56), asset_name: '414243', quantity: '5' }],
    datum_hash: null,
    inline_datum: { bytes: 'd87980' },
    reference_script: null,
  }

  it('maps a utxo with assets and inline datum (regression) and posts _extended', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [ROW])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const utxos = await provider.getUtxosByAddresses([BYRON_A])

    expect(utxos).toEqual([
      {
        txHash: 'aa11',
        outputIndex: 2,
        address: BYRON_A,
        value: '2000000',
        assets: [{ policyId: 'a'.repeat(56), assetName: '414243', quantity: '5' }],
        inlineDatum: 'd87980',
      },
    ])
    expect(calls[0]?.url).toBe(
      `${BASE}/address_utxos?order=tx_hash.asc,tx_index.asc&limit=1000&offset=0`,
    )
    expect(calls[0]?.headers).toMatchObject({ prefer: 'count=exact' })
    expect(calls[0]?.headers).not.toHaveProperty('range')
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      _addresses: [BYRON_A],
      _extended: true,
    })
  })

  it('sends every requested address in one _addresses set', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await provider.getUtxosByAddresses([BYRON_A, BYRON_B])

    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
      _addresses: [BYRON_A, BYRON_B],
    })
  })

  it('returns [] without calling upstream for an empty batch', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getUtxosByAddresses([])).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('rejects a malformed utxo shape as upstream-malformed, not a 500', async () => {
    const { fetchImpl } = fakeFetch(async () => [{ tx_hash: 'aa', tx_index: 'nope' }])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getUtxosByAddresses([BYRON_A])).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })

  // The reason /address_utxos cannot be a single request: Koios/PostgREST caps a response at 1,000
  // rows and reports the true total in Content-Range. A wallet with more than 1,000 UTxOs used to
  // silently lose everything past the first thousand. Walk every page and assemble the whole set.
  it('walks Content-Range pages and returns every utxo past the 1000-row cap', async () => {
    const rows = Array.from({ length: 1_501 }, (_, index) => ({
      ...ROW,
      tx_hash: index.toString(16).padStart(64, '0'),
      tx_index: index % 4,
      value: String(index + 1),
      asset_list: null,
      inline_datum: null,
    }))
    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body, headers: init?.headers })
      const offset = new URL(url).searchParams.get('offset')
      if (offset === '0') {
        return {
          ok: true,
          status: 206,
          headers: { get: (name) => (name === 'content-range' ? '0-999/1501' : null) },
          json: async () => rows.slice(0, 1_000),
          text: async () => '',
        }
      }
      if (offset === '1000') {
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (name === 'content-range' ? '1000-1500/1501' : null) },
          json: async () => rows.slice(1_000),
          text: async () => '',
        }
      }
      throw new Error(`unexpected offset: ${offset}`)
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const utxos = await provider.getUtxosByAddresses([BYRON_A])

    expect(utxos).toHaveLength(1_501)
    expect(calls.map((call) => new URL(call.url).searchParams.get('offset'))).toEqual(['0', '1000'])
    expect(utxos[1_500]).toMatchObject({ value: '1501' })
  })

  // A repeated output reference across two pages is upstream inconsistency, not a wallet holding
  // the same UTxO twice, so it must fail loudly rather than double-count the balance.
  it('rejects the same output reference appearing on two pages', async () => {
    const dup = {
      ...ROW,
      tx_hash: 'a'.repeat(64),
      tx_index: 0,
      asset_list: null,
      inline_datum: null,
    }
    const fetchImpl: FetchLike = async (url) => {
      const first = new URL(url).searchParams.get('offset') === '0'
      return {
        ok: true,
        status: first ? 206 : 200,
        headers: { get: (name) => (name === 'content-range' ? (first ? '0-0/2' : '1-1/2') : null) },
        json: async () => [dup],
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getUtxosByAddresses([BYRON_A])).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })
})

function txInfoRowFor(hash: string, block: number) {
  return {
    tx_hash: hash,
    block_hash: `h${block}`,
    block_height: block,
    epoch_no: 1,
    absolute_slot: block * 100,
    tx_timestamp: block * 10,
    tx_block_index: 0,
    fee: '150000',
    inputs: [],
    outputs: [],
    withdrawals: [],
    certificates: [],
  }
}

describe('koios getTxHistoryByAddresses', () => {
  const ADDRESS_TXS = [
    { tx_hash: 'bb', block_height: 9, block_time: 90, epoch_no: 1 },
    { tx_hash: 'aa', block_height: 10, block_time: 100, epoch_no: 1 },
  ]
  const TX_INFO = [txInfoRowFor('bb', 9), txInfoRowFor('aa', 10)]

  it('lists then details transactions, mapped and oldest-first (regression)', async () => {
    const { fetchImpl, calls } = fakeFetchByPath({
      '/address_txs': ADDRESS_TXS,
      '/tx_info': TX_INFO,
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const history = await provider.getTxHistoryByAddresses([BYRON_A])

    expect(history.map((t) => t.txHash)).toEqual(['bb', 'aa'])
    const listCall = calls.find((c) => c.url.includes('/address_txs'))
    expect(listCall?.method).toBe('POST')
    expect(listCall?.headers).toMatchObject({ prefer: 'count=exact' })
    expect(JSON.parse(String(listCall?.body))).toEqual({ _addresses: [BYRON_A] })
  })

  // Full field mapping, not just the hash: inputs, outputs, withdrawals and a certificate, both
  // a recognized kind and an unrecognized one falling back to 'other'.
  it('maps inputs, outputs, withdrawals and certificates (regression)', async () => {
    const detailed = {
      ...txInfoRowFor('aa', 10),
      invalid_after: 999,
      inputs: [{ payment_addr: { bech32: BYRON_A }, value: '5000000', asset_list: null }],
      outputs: [
        {
          payment_addr: null, // some Byron outputs can't be expressed as bech32
          value: '4800000',
          asset_list: [{ policy_id: 'd'.repeat(56), asset_name: '4142', quantity: '3' }],
        },
      ],
      withdrawals: [{ stake_addr: 'stake_w', amount: '250000' }],
      certificates: [
        { index: 0, type: 'delegation' },
        { index: 1, type: 'some_future_cert' },
      ],
      metadata: { '674': { msg: ['hi'] } },
    }
    const { fetchImpl } = fakeFetchByPath({
      '/address_txs': [{ tx_hash: 'aa', block_height: 10, block_time: 100, epoch_no: 1 }],
      '/tx_info': [detailed],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [tx] = await provider.getTxHistoryByAddresses([BYRON_A])

    expect(tx).toEqual({
      txHash: 'aa',
      block: 10,
      blockHash: 'h10',
      slot: 1000,
      epoch: 1,
      blockTime: 100,
      fee: '150000',
      ttl: 999,
      inputs: [{ address: BYRON_A, value: '5000000', assets: [] }],
      outputs: [
        {
          address: undefined,
          value: '4800000',
          assets: [{ policyId: 'd'.repeat(56), assetName: '4142', quantity: '3' }],
        },
      ],
      withdrawals: [{ stakeAddress: 'stake_w', amount: '250000' }],
      certificates: [
        { kind: 'stake_delegation', index: 0 },
        { kind: 'other', index: 1 },
      ],
      metadata: { '674': { msg: ['hi'] } },
    })
  })

  it('passes after as _after_block_height in the POST body', async () => {
    const { fetchImpl, calls } = fakeFetchByPath({
      '/address_txs': ADDRESS_TXS,
      '/tx_info': TX_INFO,
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await provider.getTxHistoryByAddresses([BYRON_A], 500)

    const listCall = calls.find((c) => c.url.includes('/address_txs'))
    expect(JSON.parse(String(listCall?.body))).toEqual({
      _addresses: [BYRON_A],
      _after_block_height: 500,
    })
  })

  // The behavior /address_txs needs that /account_txs never did: two of the given addresses can
  // both belong to the same wallet and both appear on the same transaction (a self-transfer,
  // most commonly), and Koios answers per address. Without collapsing to one row per tx_hash,
  // this transaction would occupy two slots in the page and /tx_info would see it requested
  // twice, tripping the duplicate-transaction guard for a wallet that did nothing wrong.
  it('counts a transaction shared by two requested addresses once, not twice', async () => {
    const sharedTx = { tx_hash: 'cc', block_height: 20, block_time: 200, epoch_no: 2 }
    const { fetchImpl, calls } = fakeFetchByPath({
      '/address_txs': [sharedTx],
      '/tx_info': [txInfoRowFor('cc', 20)],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const history = await provider.getTxHistoryByAddresses([BYRON_A, BYRON_B])

    expect(history.map((t) => t.txHash)).toEqual(['cc'])
    const txInfoCall = calls.find((c) => c.url.includes('/tx_info'))
    expect(JSON.parse(String(txInfoCall?.body))._tx_hashes).toEqual(['cc'])
  })

  it('stops a large history once the first 50 and its boundary are determined', async () => {
    const txs = Array.from({ length: 1_501 }, (_, index) => ({
      tx_hash: `t${index}`,
      block_height: index,
      block_time: index * 10,
      epoch_no: 1,
    }))
    const oldest = txs.slice(0, 50)
    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body, headers: init?.headers })
      if (url.includes('/tx_info')) {
        return {
          ok: true,
          status: 200,
          json: async () => oldest.map((t) => txInfoRowFor(t.tx_hash, t.block_height)),
          text: async () => '',
        }
      }
      const query = new URL(url).searchParams
      const offset = Number(query.get('offset'))
      const limit = Number(query.get('limit'))
      if (offset === 0) {
        return {
          ok: true,
          status: 206,
          headers: { get: (name) => (name === 'content-range' ? '0-49/1501' : null) },
          json: async () => txs.slice(offset, offset + limit),
          text: async () => '',
        }
      }
      if (offset === 50) {
        return {
          ok: true,
          status: 206,
          headers: { get: (name) => (name === 'content-range' ? '50-99/1501' : null) },
          json: async () => txs.slice(offset, offset + limit),
          text: async () => '',
        }
      }
      // This tail can fail and the requested history page is still fully known. Fetching it would
      // reproduce the active-address failure this regression prevents.
      throw new Error(`irrelevant history tail fetched at offset ${offset}`)
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const history = await provider.getTxHistoryByAddresses([BYRON_A])

    const listOffsets = calls
      .filter((c) => c.url.includes('/address_txs'))
      .map((c) => new URL(c.url).searchParams.get('offset'))
    expect(listOffsets).toEqual(['0', '50'])
    expect(history).toHaveLength(50)
    expect(history[0]?.txHash).toBe('t0')
    expect(history[49]?.txHash).toBe('t49')
  })

  it('continues through every incremental page tied at the boundary block', async () => {
    const early = Array.from({ length: 49 }, (_, index) => ({
      tx_hash: `e${index.toString().padStart(3, '0')}`,
      block_height: index,
      block_time: index * 10,
      epoch_no: 1,
    }))
    const boundary = Array.from({ length: 120 }, (_, index) => ({
      tx_hash: `b${index.toString().padStart(3, '0')}`,
      block_height: 49,
      block_time: 490,
      epoch_no: 1,
    }))
    const later = { tx_hash: 'later', block_height: 50, block_time: 500, epoch_no: 1 }
    const rows = [...early, ...boundary, later]
    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body })
      if (url.includes('/tx_info')) {
        const hashes = (JSON.parse(String(init?.body)) as { _tx_hashes: string[] })._tx_hashes
        const byHash = new Map(rows.map((row) => [row.tx_hash, row]))
        return {
          ok: true,
          status: 200,
          json: async () =>
            hashes.map((hash) => {
              const row = byHash.get(hash)!
              return txInfoRowFor(hash, row.block_height)
            }),
          text: async () => '',
        }
      }
      const query = new URL(url).searchParams
      const offset = Number(query.get('offset'))
      const limit = Number(query.get('limit'))
      const page = rows.slice(offset, offset + limit)
      const end = offset + page.length - 1
      return {
        ok: true,
        status: end + 1 === rows.length ? 200 : 206,
        headers: {
          get: (name) => (name === 'content-range' ? `${offset}-${end}/${rows.length}` : null),
        },
        json: async () => page,
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const history = await provider.getTxHistoryByAddresses([BYRON_A])

    expect(history).toHaveLength(169)
    expect(history.map((tx) => tx.txHash)).not.toContain('later')
    expect(
      calls
        .filter((call) => call.url.includes('/address_txs'))
        .map((call) => new URL(call.url).searchParams.get('offset')),
    ).toEqual(['0', '50', '100', '150'])
  })

  it('fails when walking past the consumed-row safety bound', async () => {
    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body })
      const query = new URL(url).searchParams
      const offset = Number(query.get('offset'))
      const limit = Number(query.get('limit'))
      if (url.includes('/tx_info')) throw new Error('details must not be requested')
      const page = Array.from({ length: Math.min(limit, 100_001 - offset) }, (_, index) => ({
        tx_hash: `bound-${(offset + index).toString().padStart(6, '0')}`,
        block_height: 1,
        block_time: 10,
        epoch_no: 1,
      }))
      const end = offset + page.length - 1
      return {
        ok: true,
        status: end + 1 === 100_001 ? 200 : 206,
        headers: { get: (name) => (name === 'content-range' ? `${offset}-${end}/100001` : null) },
        json: async () => page,
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({
      baseUrl: BASE,
      fetchImpl,
      readAttempts: 1,
      retryBackoffMs: 0,
    })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toThrow(
      'koios paged result exceeds 100000 rows for /address_txs',
    )
    expect(calls.filter((call) => call.url.includes('/address_txs'))).toHaveLength(2_001)
  })

  it('keeps a validated prefix when an upstream total changes in the unconsumed tail', async () => {
    const stale = Array.from({ length: 61 }, (_, block) => ({
      tx_hash: `stale-${block}`,
      block_height: block,
      block_time: block * 10,
      epoch_no: 1,
    }))
    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body })
      if (url.includes('/tx_info')) {
        const hashes = (JSON.parse(String(init?.body)) as { _tx_hashes: string[] })._tx_hashes
        return {
          ok: true,
          status: 200,
          json: async () =>
            hashes.map((hash) => {
              const row = stale.find((candidate) => candidate.tx_hash === hash)!
              return txInfoRowFor(hash, row.block_height)
            }),
          text: async () => '',
        }
      }

      const offset = Number(new URL(url).searchParams.get('offset'))
      if (offset === 0) {
        return {
          ok: true,
          status: 206,
          headers: { get: (name) => (name === 'content-range' ? '0-49/60' : null) },
          json: async () => stale.slice(0, 50),
          text: async () => '',
        }
      }
      return {
        ok: true,
        status: 206,
        // The rows in the requested prefix are unchanged, but the count sampled by Koios moved
        // because one tail row was indexed between requests. PostgREST still answers 206 for
        // this short final page, and the range itself proves the stream is complete.
        headers: { get: (name) => (name === 'content-range' ? '50-60/61' : null) },
        json: async () => stale.slice(50),
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({
      baseUrl: BASE,
      fetchImpl,
      readAttempts: 2,
      retryBackoffMs: 0,
    })

    const history = await provider.getTxHistoryByAddresses([BYRON_A])

    expect(history.map((tx) => tx.txHash)).toEqual(stale.slice(0, 50).map((row) => row.tx_hash))
    expect(
      calls
        .filter((call) => call.url.includes('/address_txs'))
        .map((call) => new URL(call.url).searchParams.get('offset')),
    ).toEqual(['0', '50'])
  })

  it('restarts the complete read after a malformed page', async () => {
    const rows = Array.from({ length: 60 }, (_, block) => ({
      tx_hash: `retry-${block}`,
      block_height: block,
      block_time: block * 10,
      epoch_no: 1,
    }))
    const calls: string[] = []
    let firstAttempt = true
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes('/tx_info')) {
        const hashes = (JSON.parse(String(init?.body)) as { _tx_hashes: string[] })._tx_hashes
        return {
          ok: true,
          status: 200,
          json: async () => hashes.map((hash) => txInfoRowFor(hash, Number(hash.split('-')[1]))),
          text: async () => '',
        }
      }
      const offset = Number(new URL(url).searchParams.get('offset'))
      calls.push(String(offset))
      const page = rows.slice(offset, offset + 50)
      const responsePage = firstAttempt && offset === 50 ? [...page].reverse() : page
      if (offset === 50) firstAttempt = false
      const end = offset + responsePage.length - 1
      return {
        ok: true,
        status: 206,
        headers: { get: (name) => (name === 'content-range' ? `${offset}-${end}/60` : null) },
        json: async () => responsePage,
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({
      baseUrl: BASE,
      fetchImpl,
      readAttempts: 2,
      retryBackoffMs: 0,
    })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).resolves.toHaveLength(50)
    expect(calls).toEqual(['0', '50', '0', '50'])
  })

  it('stops after the read-attempt budget when malformed pages persist', async () => {
    const rows = Array.from({ length: 60 }, (_, block) => ({
      tx_hash: `budget-${block}`,
      block_height: block,
      block_time: block * 10,
      epoch_no: 1,
    }))
    const offsets: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      const offset = Number(new URL(url).searchParams.get('offset'))
      offsets.push(String(offset))
      if (url.includes('/tx_info'))
        return { ok: true, status: 200, json: async () => [], text: async () => '' }
      const page = rows.slice(offset, offset + 50)
      const responsePage = offset === 50 ? [...page].reverse() : page
      const end = offset + responsePage.length - 1
      return {
        ok: true,
        status: 206,
        headers: { get: (name) => (name === 'content-range' ? `${offset}-${end}/60` : null) },
        json: async () => responsePage,
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({
      baseUrl: BASE,
      fetchImpl,
      readAttempts: 2,
      retryBackoffMs: 0,
    })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
    expect(offsets).toEqual(['0', '50', '0', '50'])
  })

  it('k-way merges sparse packed streams and counts shared transactions once', async () => {
    const addresses = Array.from({ length: 200 }, (_, index) =>
      `addr_${index.toString().padStart(3, '0')}`.padEnd(80, 'x'),
    )
    const allRows = Array.from({ length: 100 }, (_, block) => ({
      tx_hash: block.toString(16).padStart(64, '0'),
      block_height: block,
      block_time: block * 10,
      epoch_no: 1,
    }))
    const byHash = new Map(allRows.map((row) => [row.tx_hash, row]))
    const streamIds = new Map<string, number>()
    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body })
      if (url.includes('/tx_info')) {
        const hashes = (JSON.parse(String(init?.body)) as { _tx_hashes: string[] })._tx_hashes
        return {
          ok: true,
          status: 200,
          json: async () =>
            hashes.map((hash) => {
              const row = byHash.get(hash)!
              return txInfoRowFor(hash, row.block_height)
            }),
          text: async () => '',
        }
      }

      const bodyKey = String(init?.body)
      let streamId = streamIds.get(bodyKey)
      if (streamId === undefined) {
        streamId = streamIds.size
        streamIds.set(bodyKey, streamId)
      }
      const rows =
        streamId === 0
          ? allRows.filter((row) => row.block_height % 2 === 0)
          : streamId === 1
            ? [...allRows.filter((row) => row.block_height % 2 === 1), allRows[10]!].sort(
                (a, b) => a.block_height - b.block_height,
              )
            : []
      const query = new URL(url).searchParams
      const offset = Number(query.get('offset'))
      const limit = Number(query.get('limit'))
      const page = rows.slice(offset, offset + limit)
      if (page.length === 0) {
        return { ok: true, status: 200, json: async () => [], text: async () => '' }
      }
      const end = offset + page.length - 1
      return {
        ok: true,
        status: end + 1 === rows.length ? 200 : 206,
        headers: {
          get: (name) => (name === 'content-range' ? `${offset}-${end}/${rows.length}` : null),
        },
        json: async () => page,
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const history = await provider.getTxHistoryByAddresses(addresses)

    expect(streamIds.size).toBeGreaterThan(2)
    expect(history.map((tx) => tx.block)).toEqual(Array.from({ length: 50 }, (_, index) => index))
    expect(new Set(history.map((tx) => tx.txHash))).toHaveLength(50)
    const listCalls = calls.filter((call) => call.url.includes('/address_txs'))
    expect(listCalls).toHaveLength(streamIds.size)
    expect(listCalls.every((call) => new URL(call.url).searchParams.get('offset') === '0')).toBe(
      true,
    )
  })

  it('propagates failure from a page required to find 50 distinct transactions', async () => {
    const firstPage = Array.from({ length: 25 }, (_, block) => ({
      tx_hash: block.toString(16).padStart(64, '0'),
      block_height: block,
      block_time: block * 10,
      epoch_no: 1,
    })).flatMap((row) => [row, row])
    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body })
      const offset = Number(new URL(url).searchParams.get('offset'))
      if (offset === 0) {
        return {
          ok: true,
          status: 206,
          headers: { get: (name) => (name === 'content-range' ? '0-49/51' : null) },
          json: async () => firstPage,
          text: async () => '',
        }
      }
      return { ok: false, status: 503, json: async () => ({}), text: async () => 'unavailable' }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toBeInstanceOf(ProviderError)
    expect(calls.map((call) => new URL(call.url).searchParams.get('offset'))).toEqual(['0', '50'])
  })

  it('rejects an out-of-order page', async () => {
    const rows = Array.from({ length: 51 }, (_, block) => ({
      tx_hash: `order-${block}`,
      block_height: block,
      block_time: block * 10,
      epoch_no: 1,
    }))
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/tx_info')) throw new Error('details must not be requested')
      const offset = Number(new URL(url).searchParams.get('offset'))
      const page = offset === 0 ? rows.slice(0, 50) : [{ ...rows[0], tx_hash: 'order-bad' }]
      const end = offset + page.length - 1
      return {
        ok: true,
        status: 206,
        headers: { get: (name) => (name === 'content-range' ? `${offset}-${end}/51` : null) },
        json: async () => page,
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toThrow(
      'koios returned an out-of-order page for /address_txs',
    )
  })

  it('rejects a non-contiguous page', async () => {
    const rows = Array.from({ length: 51 }, (_, block) => ({
      tx_hash: `contiguous-${block}`,
      block_height: block,
      block_time: block * 10,
      epoch_no: 1,
    }))
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/tx_info')) throw new Error('details must not be requested')
      const offset = Number(new URL(url).searchParams.get('offset'))
      const page = rows.slice(offset, offset + 50)
      const start = offset === 50 ? 51 : 0
      const end = start + page.length - 1
      const total = offset === 50 ? 52 : 51
      return {
        ok: true,
        status: 206,
        headers: { get: (name) => (name === 'content-range' ? `${start}-${end}/${total}` : null) },
        json: async () => page,
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toThrow(
      'koios returned a non-contiguous page for /address_txs',
    )
  })

  it('rejects an incomplete 200 response with a partial Content-Range', async () => {
    const rows = Array.from({ length: 30 }, (_, block) => ({
      tx_hash: `partial-${block}`,
      block_height: block,
      block_time: block * 10,
      epoch_no: 1,
    }))
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/tx_info')) throw new Error('details must not be requested')
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-range' ? '0-29/60' : null) },
        json: async () => rows,
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toThrow(
      'koios returned an incomplete successful response for /address_txs',
    )
  })

  it('rejects a partial response that omits Content-Range', async () => {
    const rows = Array.from({ length: 30 }, (_, block) => ({
      tx_hash: `unranged-partial-${block}`,
      block_height: block,
      block_time: block * 10,
      epoch_no: 1,
    }))
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/tx_info')) throw new Error('details must not be requested')
      return { ok: true, status: 206, json: async () => rows, text: async () => '' }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toThrow(
      'koios omitted Content-Range from a partial response for /address_txs',
    )
  })

  it('rejects rows paired with an empty Content-Range', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/tx_info')) throw new Error('details must not be requested')
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-range' ? '*/0' : null) },
        json: async () => [
          { tx_hash: 'empty-range-row', block_height: 1, block_time: 10, epoch_no: 1 },
        ],
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toThrow(
      'koios returned rows for an empty Content-Range on /address_txs',
    )
  })

  it('probes the history bound and rejects an extra row without Content-Range', async () => {
    const calls: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/tx_info')) throw new Error('details must not be requested')
      const query = new URL(url).searchParams
      const offset = Number(query.get('offset'))
      const limit = Number(query.get('limit'))
      calls.push(`${offset}:${limit}`)
      if (offset < 100_000) {
        const rows = Array.from({ length: limit }, (_, index) => ({
          // Keep the logical transaction count below 50 so the bounded merge must walk to the
          // safety-bound probe instead of stopping after its first page.
          tx_hash: 'bound-shared',
          block_height: offset + index,
          block_time: (offset + index) * 10,
          epoch_no: 1,
        }))
        const end = offset + rows.length - 1
        return {
          ok: true,
          status: 206,
          headers: { get: (name) => (name === 'content-range' ? `${offset}-${end}/100001` : null) },
          json: async () => rows,
          text: async () => '',
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => [
          { tx_hash: 'bound-shared', block_height: 100_000, block_time: 1_000_000, epoch_no: 1 },
        ],
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({
      baseUrl: BASE,
      fetchImpl,
      readAttempts: 1,
      retryBackoffMs: 0,
    })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toThrow(
      'koios paged result exceeds 100000 rows for /address_txs',
    )
    expect(calls.at(-1)).toBe('100000:1')
  })

  it('rejects a full page without Content-Range', async () => {
    const rows = Array.from({ length: 50 }, (_, block) => ({
      tx_hash: `unranged-${block}`,
      block_height: block,
      block_time: block * 10,
      epoch_no: 1,
    }))
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/tx_info')) throw new Error('details must not be requested')
      return { ok: true, status: 200, json: async () => rows, text: async () => '' }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toThrow(
      'koios returned a full page without Content-Range for /address_txs',
    )
  })

  it('returns empty and skips tx_info when no address has transactions', async () => {
    const { fetchImpl, calls } = fakeFetchByPath({ '/address_txs': [] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).resolves.toEqual([])
    expect(calls.some((c) => c.url.includes('/tx_info'))).toBe(false)
  })

  it('returns [] without calling upstream for an empty address list', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistoryByAddresses([])).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('rejects a malformed address_txs row as upstream-malformed, not a 500', async () => {
    const { fetchImpl } = fakeFetchByPath({
      '/address_txs': [{ tx_hash: 'aa' }], // missing block_height, block_time, epoch_no
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })

  it('rejects a malformed tx_info row', async () => {
    const { fetchImpl } = fakeFetchByPath({
      '/address_txs': ADDRESS_TXS,
      '/tx_info': [{ tx_hash: 'aa' }],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })

  it('rejects when tx_info omits a requested transaction', async () => {
    const { fetchImpl } = fakeFetchByPath({
      '/address_txs': ADDRESS_TXS,
      '/tx_info': [txInfoRowFor('aa', 10)], // 'bb' silently missing
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })

  it('rejects when tx_info returns the same requested transaction twice', async () => {
    const { fetchImpl } = fakeFetchByPath({
      '/address_txs': [ADDRESS_TXS[0]],
      '/tx_info': [txInfoRowFor('aa', 10), txInfoRowFor('aa', 10)],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })

  it('rejects when tx_info returns an unrequested transaction', async () => {
    const { fetchImpl } = fakeFetchByPath({
      '/address_txs': [ADDRESS_TXS[0]],
      '/tx_info': [txInfoRowFor('aa', 10), txInfoRowFor('zz', 10)],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistoryByAddresses([BYRON_A])).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })
})

// The reads pack a large address set into several request bodies and then page each body. Behind a
// self-hosted or proxied Koios that advertises a smaller body cap than the documented one, the
// first packing overshoots and upstream answers 413 naming the real limit. The reads share
// batchAll's limit-learning, so they lower the budget, repack the set into smaller chunks, and
// complete, each chunk still walked page by page, rather than surfacing that 413 as a 502.
describe('koios address reads — 413 body-limit adaptation', () => {
  // Distinct 30-char addresses: all of them fit in one body under the default 5,120-byte budget,
  // but split into 2-per-chunk once the budget is lowered to the 248 bytes the 413 names below.
  const ADDRS = Array.from({ length: 6 }, (_, i) => `addr_${i}`.padEnd(30, '0'))

  it('learns a smaller body limit from a 413, repacks, and pages every chunk', async () => {
    let rejectedOversizedBody = false
    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body, headers: init?.headers })
      const body = JSON.parse(String(init?.body))
      const count = body._addresses.length

      // The first attempt packs all six addresses into one body. Reject it once, naming a cap that
      // forces the repack below to produce more than one chunk.
      if (!rejectedOversizedBody && count > 2) {
        rejectedOversizedBody = true
        return {
          ok: false,
          status: 413,
          json: async () => ({}),
          text: async () =>
            'Payload too large, body length was 812. Please ensure your request body size is below 248 bytes',
        }
      }

      // After the repack: a two-address chunk, walked across two Content-Range pages so the fix is
      // shown to compose packing, limit-learning, and paging together.
      const addr = body._addresses[0]
      const offset = new URL(url).searchParams.get('offset')
      const row = (suffix: string, index: number, value: string) => ({
        tx_hash: `${addr}#${suffix}`,
        tx_index: index,
        address: addr,
        value,
        asset_list: null,
        datum_hash: null,
        inline_datum: null,
        reference_script: null,
      })
      if (offset === '0') {
        return {
          ok: true,
          status: 206,
          headers: { get: (name) => (name === 'content-range' ? '0-0/2' : null) },
          json: async () => [row('a', 0, '1000000')],
          text: async () => '',
        }
      }
      if (offset === '1') {
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (name === 'content-range' ? '1-1/2' : null) },
          json: async () => [row('b', 1, '2000000')],
          text: async () => '',
        }
      }
      throw new Error(`unexpected offset: ${offset}`)
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const utxos = await provider.getUtxosByAddresses(ADDRS)

    // Three chunks of two addresses, two pages each: six UTxOs, none lost to the 413.
    expect(utxos).toHaveLength(6)
    expect(rejectedOversizedBody).toBe(true)

    const addressCounts = calls.map((c) => JSON.parse(String(c.body))._addresses.length)
    // The single oversized attempt, then every follow-up carrying at most the learned chunk size.
    expect(addressCounts[0]).toBe(6)
    expect(addressCounts.slice(1).every((n) => n <= 2)).toBe(true)
  })
})
