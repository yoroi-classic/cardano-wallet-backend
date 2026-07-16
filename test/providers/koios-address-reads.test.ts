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
}

function fakeFetch(json: () => Promise<unknown>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body })
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
    expect(calls[0]?.url).toBe(`${BASE}/address_utxos`)
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
