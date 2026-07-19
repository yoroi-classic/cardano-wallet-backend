import { describe, expect, it } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'
import { MalformedUpstreamError } from '../../src/domain/errors.js'

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
    calls.push({ url, method: init?.method, body: init?.body })
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
    { tx_hash: 'aa', block_height: 10, block_time: 100, epoch_no: 1 },
    { tx_hash: 'bb', block_height: 9, block_time: 90, epoch_no: 1 }, // older, listed second
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

  // /address_txs is capped at 1,000 rows per response the same way. Ordered oldest-first, the
  // window this endpoint returns lives in the first page, but the read must still walk the whole
  // Content-Range so no history is skipped for a set with more than 1,000 matching transactions.
  it('walks Content-Range pages of address_txs before windowing the history', async () => {
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
      const offset = new URL(url).searchParams.get('offset')
      if (offset === '0') {
        return {
          ok: true,
          status: 206,
          headers: { get: (name) => (name === 'content-range' ? '0-999/1501' : null) },
          json: async () => txs.slice(0, 1_000),
          text: async () => '',
        }
      }
      if (offset === '1000') {
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (name === 'content-range' ? '1000-1500/1501' : null) },
          json: async () => txs.slice(1_000),
          text: async () => '',
        }
      }
      throw new Error(`unexpected offset: ${offset}`)
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const history = await provider.getTxHistoryByAddresses([BYRON_A])

    const listOffsets = calls
      .filter((c) => c.url.includes('/address_txs'))
      .map((c) => new URL(c.url).searchParams.get('offset'))
    expect(listOffsets).toEqual(['0', '1000'])
    expect(history).toHaveLength(50)
    expect(history[0]?.txHash).toBe('t0')
    expect(history[49]?.txHash).toBe('t49')
  })

  it('does not cut a page through the middle of a block', async () => {
    // 3 transactions in the same boundary block, page size 50: all fit under the page size on
    // their own, so this checks the simpler case of the same logic account.ts uses — the
    // boundary-extension branch is exercised more heavily by koios-account.test.ts, and this
    // guards that the address-keyed copy of the same algorithm agrees with it.
    const rows = [
      { tx_hash: 'x1', block_height: 1, block_time: 10, epoch_no: 1 },
      { tx_hash: 'x2', block_height: 1, block_time: 10, epoch_no: 1 },
      { tx_hash: 'x3', block_height: 2, block_time: 20, epoch_no: 1 },
    ]
    const { fetchImpl } = fakeFetchByPath({
      '/address_txs': rows,
      '/tx_info': [txInfoRowFor('x1', 1), txInfoRowFor('x2', 1), txInfoRowFor('x3', 2)],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const history = await provider.getTxHistoryByAddresses([BYRON_A])

    expect(history.map((t) => t.txHash)).toEqual(['x1', 'x2', 'x3'])
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
