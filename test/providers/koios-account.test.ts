import { describe, expect, it } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'
import { BadRequestError, MalformedUpstreamError, ProviderError } from '../../src/domain/errors.js'

const BASE = 'https://preprod.koios.rest/api/v1'
const STAKE = 'stake_test1uqrw9tjymlm8wrz8g8g9q2q0k3s0nq4z9m0q9c0s0'

interface Call {
  url: string
  method?: string
  body?: string | Uint8Array
  contentType?: string
}

function fakeFetch(response: {
  ok?: boolean
  status?: number
  json?: () => Promise<unknown>
  text?: () => Promise<string>
  throws?: unknown
}): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body,
      contentType: init?.headers?.['content-type'],
    })
    if (response.throws) throw response.throws
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: response.json ?? (async () => ({})),
      text: response.text ?? (async () => ''),
    }
  }
  return { fetchImpl, calls }
}

describe('koios getAccountState', () => {
  const ROW = {
    stake_address: STAKE,
    status: 'registered',
    delegated_pool: 'pool1abc',
    delegated_drep: 'drep1xyz',
    total_balance: '1000000',
    rewards_available: '250000',
    rewards: '900000',
    withdrawals: '650000',
  }

  it('maps a registered account (regression) and posts the stake address', async () => {
    const { fetchImpl, calls } = fakeFetch({ json: async () => [ROW] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const state = await provider.getAccountState(STAKE)

    expect(state).toEqual({
      stakeAddress: STAKE,
      registered: true,
      balance: '1000000',
      rewardsAvailable: '250000',
      rewardsSum: '900000',
      withdrawalsSum: '650000',
      delegatedPool: 'pool1abc',
      delegatedDrep: 'drep1xyz',
    })
    expect(calls[0]?.url).toBe(`${BASE}/account_info`)
    expect(calls[0]?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ _stake_addresses: [STAKE] })
  })

  it('reports an unknown stake as unregistered with zero balance', async () => {
    const { fetchImpl } = fakeFetch({ json: async () => [] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const state = await provider.getAccountState(STAKE)

    expect(state).toEqual({
      stakeAddress: STAKE,
      registered: false,
      balance: '0',
      rewardsAvailable: '0',
      rewardsSum: '0',
      withdrawalsSum: '0',
    })
  })

  it('leaves delegations undefined when Koios returns null', async () => {
    const rows = [{ ...ROW, delegated_pool: null, delegated_drep: null }]
    const { fetchImpl } = fakeFetch({ json: async () => rows })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const state = await provider.getAccountState(STAKE)

    expect(state.delegatedPool).toBeUndefined()
    expect(state.delegatedDrep).toBeUndefined()
  })

  it('rejects an unexpected account status as malformed', async () => {
    const { fetchImpl } = fakeFetch({ json: async () => [{ ...ROW, status: 'weird' }] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getAccountState(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('surfaces an upstream error', async () => {
    const { fetchImpl } = fakeFetch({ ok: false, status: 500, text: async () => 'boom' })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getAccountState(STAKE)).rejects.toBeInstanceOf(ProviderError)
  })
})

describe('koios getAccountUtxos', () => {
  const ROW = {
    tx_hash: 'aa11',
    tx_index: 2,
    address: 'addr_test1xyz',
    value: '2000000',
    asset_list: [{ policy_id: 'a0b1c2', asset_name: '414243', quantity: '5' }],
    datum_hash: null,
    inline_datum: { bytes: 'd87980' },
    reference_script: null,
  }

  it('maps a utxo with assets and inline datum (regression)', async () => {
    const { fetchImpl, calls } = fakeFetch({ json: async () => [ROW] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const utxos = await provider.getAccountUtxos(STAKE)

    expect(utxos).toEqual([
      {
        txHash: 'aa11',
        outputIndex: 2,
        address: 'addr_test1xyz',
        value: '2000000',
        assets: [{ policyId: 'a0b1c2', assetName: '414243', quantity: '5' }],
        inlineDatum: 'd87980',
      },
    ])
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      _stake_addresses: [STAKE],
      _extended: true,
    })
  })

  it('maps a datum hash and reference script when present', async () => {
    const row = {
      ...ROW,
      asset_list: null,
      inline_datum: null,
      datum_hash: 'beef',
      reference_script: { hash: 'cafe' },
    }
    const { fetchImpl } = fakeFetch({ json: async () => [row] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [utxo] = await provider.getAccountUtxos(STAKE)

    expect(utxo).toMatchObject({ assets: [], datumHash: 'beef', referenceScriptHash: 'cafe' })
    expect(utxo?.inlineDatum).toBeUndefined()
  })

  it('returns an empty list for an account with no utxos', async () => {
    const { fetchImpl } = fakeFetch({ json: async () => [] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getAccountUtxos(STAKE)).resolves.toEqual([])
  })

  it('rejects a malformed utxo shape', async () => {
    const { fetchImpl } = fakeFetch({ json: async () => [{ tx_hash: 'aa', tx_index: 'nope' }] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})

describe('koios submitTx', () => {
  const CBOR = '84a400818258' // even-length hex, shape not validated here
  const TXID = 'ab'.repeat(32) // a 64-char hex transaction id

  it('submits cbor bytes and returns the tx hash', async () => {
    const { fetchImpl, calls } = fakeFetch({ json: async () => TXID })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const result = await provider.submitTx(CBOR)

    expect(result).toEqual({ txHash: TXID })
    expect(calls[0]?.url).toBe(`${BASE}/submittx`)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.contentType).toBe('application/cbor')
    expect(calls[0]?.body).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(calls[0]?.body as Uint8Array).toString('hex')).toBe(CBOR)
  })

  it('rejects a submit response that is not a 64-char hex hash', async () => {
    const { fetchImpl } = fakeFetch({ json: async () => 'not-a-tx-id' })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.submitTx(CBOR)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects a non-hex transaction as a bad request without calling upstream', async () => {
    const { fetchImpl, calls } = fakeFetch({ json: async () => 'x' })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.submitTx('nothex!!')).rejects.toBeInstanceOf(BadRequestError)
    expect(calls).toHaveLength(0)
  })

  it('rejects odd-length hex as a bad request', async () => {
    const { fetchImpl } = fakeFetch({ json: async () => 'x' })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.submitTx('abc')).rejects.toBeInstanceOf(BadRequestError)
  })

  it('surfaces an upstream rejection', async () => {
    const { fetchImpl } = fakeFetch({ ok: false, status: 400, text: async () => 'bad tx' })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.submitTx(CBOR)).rejects.toBeInstanceOf(ProviderError)
  })
})

describe('koios getTxStatus', () => {
  it('reports confirmations for a seen tx', async () => {
    const { fetchImpl } = fakeFetch({
      json: async () => [{ tx_hash: 'bb', num_confirmations: 12 }],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxStatus('bb')).resolves.toEqual({ seen: true, confirmations: 12 })
  })

  it('reports not-seen when Koios has no confirmation count', async () => {
    const { fetchImpl } = fakeFetch({
      json: async () => [{ tx_hash: 'bb', num_confirmations: null }],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxStatus('bb')).resolves.toEqual({ seen: false, confirmations: 0 })
  })

  it('reports not-seen for an empty response', async () => {
    const { fetchImpl } = fakeFetch({ json: async () => [] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxStatus('bb')).resolves.toEqual({ seen: false, confirmations: 0 })
  })
})

// getTxHistory makes two calls (account_txs then tx_info), so route the fake by path.
function fakeFetchByPath(responses: Record<string, unknown>): {
  fetchImpl: FetchLike
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body,
      contentType: init?.headers?.['content-type'],
    })
    const key = Object.keys(responses).find((k) => url.includes(k))
    const data = key !== undefined ? responses[key] : []
    return { ok: true, status: 200, json: async () => data, text: async () => '' }
  }
  return { fetchImpl, calls }
}

describe('koios getTxHistory', () => {
  const ACCOUNT_TXS = [
    { tx_hash: 'aa', block_height: 10, block_time: 100, epoch_no: 1 },
    { tx_hash: 'bb', block_height: 9, block_time: 90, epoch_no: 1 }, // older, listed second
  ]
  const TX_INFO = [
    {
      tx_hash: 'bb',
      block_hash: 'h9',
      block_height: 9,
      epoch_no: 1,
      absolute_slot: 900,
      tx_timestamp: 90,
      tx_block_index: 0,
      fee: '150000',
      invalid_after: 999,
      inputs: [{ payment_addr: { bech32: 'addr_in' }, value: '5000000', asset_list: null }],
      outputs: [
        {
          payment_addr: { bech32: 'addr_out' },
          value: '4800000',
          asset_list: [{ policy_id: 'd0e1f2', asset_name: '4142', quantity: '3' }],
        },
      ],
      withdrawals: [{ stake_addr: 'stake_w', amount: '250000' }],
      certificates: [{ index: 0, type: 'delegation', info: { pool: 'p' } }],
      metadata: null,
    },
    {
      tx_hash: 'aa',
      block_hash: 'h10',
      block_height: 10,
      epoch_no: 1,
      absolute_slot: 1000,
      tx_timestamp: 100,
      tx_block_index: 1,
      fee: '170000',
      invalid_after: null,
      inputs: [],
      outputs: [],
      withdrawals: [],
      certificates: [],
      metadata: { '674': { msg: ['hi'] } },
    },
  ]

  it('lists then details transactions, mapped and oldest-first (regression)', async () => {
    const { fetchImpl, calls } = fakeFetchByPath({
      '/account_txs': ACCOUNT_TXS,
      '/tx_info': TX_INFO,
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const history = await provider.getTxHistory(STAKE)

    expect(history.map((t) => t.txHash)).toEqual(['bb', 'aa'])
    expect(history[0]).toEqual({
      txHash: 'bb',
      block: 9,
      blockHash: 'h9',
      slot: 900,
      epoch: 1,
      blockTime: 90,
      fee: '150000',
      ttl: 999,
      inputs: [{ address: 'addr_in', value: '5000000', assets: [] }],
      outputs: [
        {
          address: 'addr_out',
          value: '4800000',
          assets: [{ policyId: 'd0e1f2', assetName: '4142', quantity: '3' }],
        },
      ],
      withdrawals: [{ stakeAddress: 'stake_w', amount: '250000' }],
      certificates: [{ kind: 'stake_delegation', index: 0 }],
      metadata: undefined,
    })
    expect(history[1]?.metadata).toEqual({ '674': { msg: ['hi'] } })
    const accountCall = calls.find((c) => c.url.includes('/account_txs'))
    expect(accountCall?.method ?? 'GET').toBe('GET')
    expect(accountCall?.url).toContain(`_stake_address=${STAKE}`)
  })

  it('passes afterBlock to account_txs', async () => {
    const { fetchImpl, calls } = fakeFetchByPath({
      '/account_txs': ACCOUNT_TXS,
      '/tx_info': TX_INFO,
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await provider.getTxHistory(STAKE, 500)

    const accountCall = calls.find((c) => c.url.includes('/account_txs'))
    expect(accountCall?.url).toContain(`_stake_address=${STAKE}`)
    expect(accountCall?.url).toContain('_after_block_height=500')
  })

  it('normalizes known certificates and preserves unknown ones as "other"', async () => {
    const info = [
      {
        ...TX_INFO[1],
        certificates: [
          { index: 0, type: 'stake_registration', info: { stake_address: 's' } },
          { index: 1, type: 'some_future_cert', info: { foo: 'bar' } },
        ],
      },
    ]
    const { fetchImpl } = fakeFetchByPath({ '/account_txs': [ACCOUNT_TXS[0]], '/tx_info': info })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [tx] = await provider.getTxHistory(STAKE)

    expect(tx?.certificates).toEqual([
      { kind: 'stake_registration', index: 0 },
      { kind: 'other', index: 1 },
    ])
  })

  it('accepts invalid_after delivered as a numeric string', async () => {
    const info = [{ ...TX_INFO[1], invalid_after: '12345' }]
    const { fetchImpl } = fakeFetchByPath({ '/account_txs': [ACCOUNT_TXS[0]], '/tx_info': info })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [tx] = await provider.getTxHistory(STAKE)

    expect(tx?.ttl).toBe(12345)
  })

  it('returns empty and skips tx_info when the account has no transactions', async () => {
    const { fetchImpl, calls } = fakeFetchByPath({ '/account_txs': [] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistory(STAKE)).resolves.toEqual([])
    expect(calls.some((c) => c.url.includes('/tx_info'))).toBe(false)
  })

  it('rejects a malformed tx_info row', async () => {
    const { fetchImpl } = fakeFetchByPath({
      '/account_txs': ACCOUNT_TXS,
      '/tx_info': [{ tx_hash: 'aa' }],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistory(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})

describe('koios filterUsedAddresses', () => {
  it('returns only the addresses Koios reports as seen, in input order', async () => {
    const { fetchImpl, calls } = fakeFetch({
      json: async () => [{ address: 'addrA' }, { address: 'addrC' }],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const used = await provider.filterUsedAddresses(['addrA', 'addrB', 'addrC'])

    expect(used).toEqual(['addrA', 'addrC'])
    expect(calls[0]?.url).toBe(`${BASE}/address_info`)
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ _addresses: ['addrA', 'addrB', 'addrC'] })
  })

  it('returns empty without calling upstream for an empty list', async () => {
    const { fetchImpl, calls } = fakeFetch({ json: async () => [] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.filterUsedAddresses([])).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('surfaces an upstream error', async () => {
    const { fetchImpl } = fakeFetch({ ok: false, status: 500, text: async () => 'x' })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.filterUsedAddresses(['a'])).rejects.toBeInstanceOf(ProviderError)
  })
})

describe('koios getTxHistory — upstream boundary', () => {
  const txInfoRowFor = (hash: string, block: number) => ({
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
  })

  it('chunks /tx_info when the boundary block pushes the page past the batch size', async () => {
    // 60 transactions all in the same block. The page can't be cut mid-block, so the
    // boundary extension carries all 60 past the 50-tx page size, and a single body of 60
    // hashes is what Koios answers with a 413.
    const hashes = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))
    const accountTxs = hashes.map((h) => ({
      tx_hash: h,
      block_height: 7,
      block_time: 70,
      epoch_no: 1,
    }))

    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body })
      if (url.includes('/account_txs')) {
        return { ok: true, status: 200, json: async () => accountTxs, text: async () => '' }
      }
      const requested = (JSON.parse(String(init?.body)) as { _tx_hashes: string[] })._tx_hashes
      const rows = requested.map((h) => txInfoRowFor(h, 7))
      return { ok: true, status: 200, json: async () => rows, text: async () => '' }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const txs = await provider.getTxHistory(STAKE)

    expect(txs).toHaveLength(60)
    const txInfoCalls = calls.filter((c) => c.url.includes('/tx_info'))
    expect(txInfoCalls).toHaveLength(2)
    const batches = txInfoCalls.map(
      (c) => (JSON.parse(String(c.body)) as { _tx_hashes: string[] })._tx_hashes.length,
    )
    expect(batches).toEqual([50, 10])
  })

  it('raises malformed upstream when /tx_info omits a requested transaction', async () => {
    // The caller pages forward from the last block it saw, so a transaction silently
    // missing here would be stepped over and never fetched again.
    const { fetchImpl } = fakeFetchByPath({
      '/account_txs': [
        { tx_hash: 'aa', block_height: 9, block_time: 90, epoch_no: 1 },
        { tx_hash: 'bb', block_height: 10, block_time: 100, epoch_no: 1 },
      ],
      '/tx_info': [txInfoRowFor('aa', 9)],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistory(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})
