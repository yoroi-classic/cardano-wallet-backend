import { describe, expect, it, vi } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'
import { KOIOS_BODY_LIMIT_BYTES } from '../../src/providers/koios/schema.js'
import { BadRequestError, MalformedUpstreamError, ProviderError } from '../../src/domain/errors.js'

const BASE = 'https://preprod.koios.rest/api/v1'
const STAKE = 'stake_test1uqrw9tjymlm8wrz8g8g9q2q0k3s0nq4z9m0q9c0s0'

interface Call {
  url: string
  method?: string
  body?: string | Uint8Array
  contentType?: string
  headers?: Record<string, string>
}

function fakeFetch(response: {
  ok?: boolean
  status?: number
  json?: () => Promise<unknown>
  text?: () => Promise<string>
  headers?: { get(name: string): string | null }
  throws?: unknown
}): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body,
      contentType: init?.headers?.['content-type'],
      headers: init?.headers,
    })
    if (response.throws) throw response.throws
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      headers: response.headers,
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
    asset_list: [{ policy_id: 'a'.repeat(56), asset_name: '414243', quantity: '5' }],
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
        assets: [{ policyId: 'a'.repeat(56), assetName: '414243', quantity: '5' }],
        inlineDatum: 'd87980',
      },
    ])
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      _stake_addresses: [STAKE],
      _extended: true,
    })
    expect(calls[0]?.url).toBe(
      `${BASE}/account_utxos?order=tx_hash.asc,tx_index.asc&limit=1000&offset=0`,
    )
    expect(calls[0]?.headers).toMatchObject({
      prefer: 'count=exact',
    })
    expect(calls[0]?.headers).not.toHaveProperty('range')
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

  it('collects every row when Koios returns 206 Content-Range pages', async () => {
    const rows = Array.from({ length: 1_501 }, (_, index) => ({
      ...ROW,
      tx_hash: index.toString(16).padStart(64, '0'),
      tx_index: index % 4,
      value: index === 1_500 ? '900719925474099312345' : String(index + 1),
      asset_list:
        index === 1_500
          ? [
              {
                policy_id: 'a'.repeat(56),
                asset_name: '414243',
                quantity: '900719925474099398765',
              },
            ]
          : null,
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

    const utxos = await provider.getAccountUtxos(STAKE)

    expect(utxos).toHaveLength(1_501)
    expect(calls.map((call) => new URL(call.url).searchParams.get('offset'))).toEqual(['0', '1000'])
    expect(utxos[1_500]).toMatchObject({
      value: '900719925474099312345',
      assets: [{ quantity: '900719925474099398765' }],
    })
  })

  it('fails closed when a 206 response omits Content-Range', async () => {
    const { fetchImpl } = fakeFetch({ status: 206, json: async () => [ROW] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toThrow(
      'koios omitted Content-Range from a partial response',
    )
  })

  it('rejects a 200 response whose Content-Range total is unknown', async () => {
    const { fetchImpl } = fakeFetch({
      status: 200,
      headers: { get: (name) => (name === 'content-range' ? '0-999/*' : null) },
      json: async () => [ROW],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toThrow(
      'koios returned invalid Content-Range',
    )
  })

  it('fails closed when a full-sized response does not prove it is complete', async () => {
    const { fetchImpl } = fakeFetch({
      status: 200,
      json: async () => Array.from({ length: 1_000 }, () => ROW),
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toThrow(
      'koios returned a full page without Content-Range',
    )
  })

  it('rejects duplicate outputs in a complete headerless response', async () => {
    const { fetchImpl } = fakeFetch({ status: 200, json: async () => [ROW, ROW] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toThrow(
      'koios returned a duplicate row across pages',
    )
  })

  it('fails closed when a later page overlaps the first page', async () => {
    const fetchImpl: FetchLike = async (url) => {
      const offset = new URL(url).searchParams.get('offset')
      return offset === '0'
        ? {
            ok: true,
            status: 206,
            headers: { get: (name) => (name === 'content-range' ? '0-0/2' : null) },
            json: async () => [ROW],
            text: async () => '',
          }
        : {
            ok: true,
            status: 206,
            headers: { get: (name) => (name === 'content-range' ? '0-0/2' : null) },
            json: async () => [ROW],
            text: async () => '',
          }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toThrow(
      'koios returned a non-contiguous page',
    )
  })

  it('fails closed when contiguous page metadata repeats an output', async () => {
    const fetchImpl: FetchLike = async (url) => {
      const first = new URL(url).searchParams.get('offset') === '0'
      return {
        ok: true,
        status: first ? 206 : 200,
        headers: {
          get: (name) => (name === 'content-range' ? (first ? '0-0/2' : '1-1/2') : null),
        },
        json: async () => [ROW],
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toThrow(
      'koios returned a duplicate row across pages',
    )
  })

  it('restarts the whole snapshot after a duplicate page and accepts a fresh result', async () => {
    const calls: string[] = []
    let snapshot = 1
    const fresh = { ...ROW, tx_hash: 'bb22' }
    const fetchImpl: FetchLike = async (url) => {
      const offset = String(new URL(url).searchParams.get('offset'))
      calls.push(offset)
      if (snapshot === 1 && offset === '0') {
        return {
          ok: true,
          status: 206,
          headers: { get: (name) => (name === 'content-range' ? '0-0/2' : null) },
          json: async () => [ROW],
          text: async () => '',
        }
      }
      if (snapshot === 1) {
        snapshot = 2
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (name === 'content-range' ? '1-1/2' : null) },
          json: async () => [ROW],
          text: async () => '',
        }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-range' ? '0-0/1' : null) },
        json: async () => [fresh],
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({
      baseUrl: BASE,
      fetchImpl,
      readAttempts: 2,
      retryBackoffMs: 0,
    })

    await expect(provider.getAccountUtxos(STAKE)).resolves.toEqual([
      expect.objectContaining({ txHash: 'bb22' }),
    ])
    expect(calls).toEqual(['0', '1', '0'])
  })

  it('fails closed when a complete status still reports rows remaining', async () => {
    const { fetchImpl } = fakeFetch({
      status: 200,
      headers: { get: (name) => (name === 'content-range' ? '0-0/2' : null) },
      json: async () => [ROW],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toThrow(
      'koios returned an incomplete successful response',
    )
  })

  it('rejects a Content-Range whose total does not extend past its end', async () => {
    const { fetchImpl } = fakeFetch({
      status: 206,
      headers: { get: (name) => (name === 'content-range' ? '0-1/1' : null) },
      json: async () => [ROW, { ...ROW, tx_hash: 'bb22' }],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toThrow(
      'koios returned contradictory Content-Range',
    )
  })

  it('rejects a total that changes between pages', async () => {
    const fetchImpl: FetchLike = async (url) => {
      const first = new URL(url).searchParams.get('offset') === '0'
      return {
        ok: true,
        status: 206,
        headers: {
          get: (name) => (name === 'content-range' ? (first ? '0-0/2' : '1-1/3') : null),
        },
        json: async () => [first ? ROW : { ...ROW, tx_hash: 'bb22' }],
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toThrow(
      'koios changed the paged result total',
    )
  })

  it('rejects an aggregate above the row safety bound', async () => {
    const { fetchImpl } = fakeFetch({
      status: 206,
      headers: { get: (name) => (name === 'content-range' ? '0-0/100001' : null) },
      json: async () => [ROW],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toThrow(
      'koios paged result exceeds 100000 rows',
    )
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
          asset_list: [{ policy_id: 'd'.repeat(56), asset_name: '4142', quantity: '3' }],
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
          assets: [{ policyId: 'd'.repeat(56), assetName: '4142', quantity: '3' }],
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

  it.each([
    ['a number', Number.MAX_SAFE_INTEGER],
    ['a canonical numeric string', String(Number.MAX_SAFE_INTEGER)],
  ])('accepts Number.MAX_SAFE_INTEGER as %s', async (_representation, invalidAfter) => {
    const info = [{ ...TX_INFO[1], invalid_after: invalidAfter }]
    const { fetchImpl } = fakeFetchByPath({ '/account_txs': [ACCOUNT_TXS[0]], '/tx_info': info })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [tx] = await provider.getTxHistory(STAKE)

    expect(tx?.ttl).toBe(Number.MAX_SAFE_INTEGER)
  })

  it.each([
    ['the first unrepresentable numeric string', String(Number.MAX_SAFE_INTEGER + 1)],
    ['a numeric string that Number would round down', '9007199254740993'],
    ['a 34-digit numeric string', '1'.padEnd(34, '0')],
    ['a 400-digit numeric string', '9'.repeat(400)],
  ])('omits an unrepresentable %s without rejecting history', async (_case, invalidAfter) => {
    const info = [{ ...TX_INFO[1], invalid_after: invalidAfter }]
    const { fetchImpl } = fakeFetchByPath({ '/account_txs': [ACCOUNT_TXS[0]], '/tx_info': info })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [tx] = await provider.getTxHistory(STAKE)

    expect(tx?.ttl).toBeUndefined()
  })

  it.each([
    ['null', null],
    ['absent', undefined],
  ])('preserves an %s invalid_after as an absent ttl', async (_case, invalidAfter) => {
    const row: Record<string, unknown> = { ...TX_INFO[1] }
    if (invalidAfter === undefined) {
      delete row.invalid_after
    } else {
      row.invalid_after = invalidAfter
    }
    const { fetchImpl } = fakeFetchByPath({
      '/account_txs': [ACCOUNT_TXS[0]],
      '/tx_info': [row],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [tx] = await provider.getTxHistory(STAKE)

    expect(tx?.ttl).toBeUndefined()
  })

  it.each([
    ['an unsafe number', Number.MAX_SAFE_INTEGER + 1],
    ['a negative number', -1],
    ['a fractional numeric string', '1.5'],
    ['a fractional number', 1.5],
    ['a negative sign', '-1'],
    ['a positive sign', '+1'],
    ['leading whitespace', ' 1'],
    ['trailing whitespace', '1 '],
    ['a non-canonical leading zero', '01'],
  ])('rejects invalid_after with %s as malformed upstream', async (_case, invalidAfter) => {
    const info = [{ ...TX_INFO[1], invalid_after: invalidAfter }]
    const { fetchImpl } = fakeFetchByPath({ '/account_txs': [ACCOUNT_TXS[0]], '/tx_info': info })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistory(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
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

describe('koios filterUsedPaymentCredentials', () => {
  it('splits non-empty groups to identify the exact used credential subset', async () => {
    const a = '01'.repeat(28)
    const b = '02'.repeat(28)
    const c = '03'.repeat(28)
    const calls: Call[] = []
    const used = new Set([b, c])
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body })
      const body = JSON.parse(String(init?.body)) as { _payment_credentials: string[] }
      const hasUsed = body._payment_credentials.some((credential) => used.has(credential))
      return {
        ok: true,
        status: 200,
        json: async () =>
          hasUsed ? [{ tx_hash: 'aa', block_height: 1, block_time: 2, epoch_no: 3 }] : [],
        text: async () => '',
      }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.filterUsedPaymentCredentials([a, b, c])).resolves.toEqual([b, c])
    expect(calls.every((call) => call.url === `${BASE}/credential_txs?limit=1`)).toBe(true)
    expect(calls.map((call) => JSON.parse(String(call.body))._payment_credentials)).toEqual([
      [a, b, c],
      [a, b],
      [a],
      [b],
      [c],
    ])
  })

  it('returns empty without calling upstream for an empty credential list', async () => {
    const { fetchImpl, calls } = fakeFetch({ json: async () => [] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.filterUsedPaymentCredentials([])).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('bounds the initial Koios OR-query before recursively probing matches', async () => {
    const credentials = Array.from({ length: 11 }, (_, i) =>
      i.toString(16).padStart(2, '0').repeat(28),
    )
    const { fetchImpl, calls } = fakeFetch({ json: async () => [] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.filterUsedPaymentCredentials(credentials)).resolves.toEqual([])
    expect(calls.map((call) => JSON.parse(String(call.body))._payment_credentials.length)).toEqual([
      5, 5, 1,
    ])
  })

  it('bounds concurrent initial credential probes', async () => {
    const credentials = Array.from({ length: 50 }, (_, i) =>
      i.toString(16).padStart(2, '0').repeat(28),
    )
    let active = 0
    let peak = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl: FetchLike = async () => {
      active += 1
      peak = Math.max(peak, active)
      await gate
      active -= 1
      return { ok: true, status: 200, json: async () => [], text: async () => '' }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const request = provider.filterUsedPaymentCredentials(credentials)
    await vi.waitFor(() => expect(active).toBe(4))
    release?.()

    await expect(request).resolves.toEqual([])
    expect(peak).toBe(4)
  })
})

// A minimal, schema-valid /tx_info row. Shared by the boundary suites below so there is
// one fixture to keep in step with the schema, not two.
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

describe('koios getTxHistory — upstream boundary', () => {
  it('packs /tx_info against the body budget when the boundary block enlarges the page', async () => {
    // 150 transactions all in the same block. The page can't be cut mid-block, so the boundary
    // extension carries all 150 past the 50-tx page size, and a single body holding all of them
    // is what Koios answers with a 413.
    //
    // Real 32-byte tx hashes, not the two-character stand-ins this test used to carry: the whole
    // point is that the body is packed by measured bytes, so a fixture whose items are 30x
    // smaller than the real thing would measure nothing worth measuring.
    const hashes = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(64, 'a'))
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

    expect(txs).toHaveLength(150)

    const txInfoCalls = calls.filter((c) => c.url.includes('/tx_info'))
    expect(txInfoCalls.length).toBeGreaterThan(1)

    const sent: string[] = []
    for (const call of txInfoCalls) {
      // The body carries the hashes *and* the five hydration flags, and the packer measures the
      // whole thing, so the flags cannot quietly push a chunk over the line.
      expect(Buffer.byteLength(String(call.body))).toBeLessThanOrEqual(KOIOS_BODY_LIMIT_BYTES)
      sent.push(...(JSON.parse(String(call.body)) as { _tx_hashes: string[] })._tx_hashes)
    }

    // A transaction dropped or duplicated by the chunking would be a hole in someone's history.
    expect(sent).toEqual(hashes)
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

describe('koios getTxHistory — /tx_info must return exactly what was asked for', () => {
  const ACCOUNT_TXS = [{ tx_hash: 'aa', block_height: 9, block_time: 90, epoch_no: 1 }]

  it('rejects a transaction that was never requested', async () => {
    // An unrequested row would put a transaction belonging to someone else into this
    // account's history.
    const { fetchImpl } = fakeFetchByPath({
      '/account_txs': ACCOUNT_TXS,
      '/tx_info': [txInfoRowFor('aa', 9), txInfoRowFor('zz', 9)],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistory(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects a duplicated transaction', async () => {
    // A duplicate would show the same payment twice.
    const { fetchImpl } = fakeFetchByPath({
      '/account_txs': ACCOUNT_TXS,
      '/tx_info': [txInfoRowFor('aa', 9), txInfoRowFor('aa', 9)],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxHistory(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})
