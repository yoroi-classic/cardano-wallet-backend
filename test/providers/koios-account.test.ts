import { describe, expect, it } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios.js'
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
    asset_list: [{ policy_id: 'pol1', asset_name: '414243', quantity: '5' }],
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
        assets: [{ policyId: 'pol1', assetName: '414243', quantity: '5' }],
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
