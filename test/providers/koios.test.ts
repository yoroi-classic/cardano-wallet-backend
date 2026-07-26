import { describe, expect, it, vi } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'
import {
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../../src/domain/errors.js'

const BASE = 'https://preprod.koios.rest/api/v1'

// Representative Koios payloads (arrays, as Koios returns them).
const TIP_ROWS = [
  {
    hash: 'aa11bb22',
    epoch_no: 199,
    abs_slot: 86_400_123,
    epoch_slot: 123,
    block_no: 3_500_000,
    block_time: 1_700_000_000,
  },
]

const EPOCH_PARAM_ROWS = [
  {
    epoch_no: 199,
    min_fee_a: 44,
    min_fee_b: 155_381,
    max_block_size: 90_112,
    max_tx_size: 16_384,
    max_bh_size: 1100,
    key_deposit: '2000000',
    pool_deposit: '500000000',
    min_pool_cost: '170000000',
    coins_per_utxo_size: '4310',
    max_val_size: 5000,
    collateral_percent: 150,
    max_collateral_inputs: 3,
    price_mem: 0.0577,
    price_step: 0.0000721,
    max_tx_ex_mem: '14000000',
    max_tx_ex_steps: '10000000000',
    protocol_major: 9,
    protocol_minor: 0,
    cost_models: { PlutusV1: [100, 200], PlutusV2: [300] },
  },
]

/** Build a fake fetch that returns one response and records the URL it was called with. */
function fakeFetch(response: {
  ok?: boolean
  status?: number
  json?: () => Promise<unknown>
  text?: () => Promise<string>
  throws?: unknown
}): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = []
  const fetchImpl: FetchLike = vi.fn(async (url: string) => {
    urls.push(url)
    if (response.throws) throw response.throws
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: response.json ?? (async () => ({})),
      text: response.text ?? (async () => ''),
    }
  })
  return { fetchImpl, urls }
}

describe('koios provider — happy path', () => {
  it('getTip maps the first tip row to the normalized shape', async () => {
    const { fetchImpl, urls } = fakeFetch({ json: async () => TIP_ROWS })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const tip = await provider.getTip()

    expect(tip).toEqual({
      block: 3_500_000,
      slot: 86_400_123,
      epoch: 199,
      hash: 'aa11bb22',
      // Carried through from block_time. A slot is not a timestamp, so a client (and /v1/status)
      // has no way to tell how far behind the chain is without it.
      blockTime: 1_700_000_000,
    })
    expect(urls[0]).toBe(`${BASE}/tip`)
  })

  it('sends a bearer token when configured', async () => {
    const headersSeen: Record<string, string>[] = []
    const fetchImpl: FetchLike = async (_url, init) => {
      headersSeen.push(init?.headers ?? {})
      return { ok: true, status: 200, json: async () => TIP_ROWS, text: async () => '' }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, token: 'secret', fetchImpl })

    await provider.getTip()

    expect(headersSeen[0]?.authorization).toBe('Bearer secret')
  })

  it('getProtocolParams maps and normalizes the latest epoch params (regression)', async () => {
    const { fetchImpl, urls } = fakeFetch({ json: async () => EPOCH_PARAM_ROWS })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const params = await provider.getProtocolParams()

    // Full-shape assertion guards against silent mapping drift.
    expect(params).toEqual({
      epoch: 199,
      minFeeA: 44,
      minFeeB: 155_381,
      maxTxSize: 16_384,
      maxBlockBodySize: 90_112,
      keyDeposit: '2000000',
      poolDeposit: '500000000',
      minPoolCost: '170000000',
      coinsPerUtxoByte: '4310',
      maxValueSize: 5000,
      collateralPercent: 150,
      maxCollateralInputs: 3,
      priceMem: 0.0577,
      priceStep: 0.0000721,
      maxTxExMem: '14000000',
      maxTxExSteps: '10000000000',
      protocolVersion: { major: 9, minor: 0 },
      costModels: { PlutusV1: [100, 200], PlutusV2: [300] },
    })
    expect(urls[0]).toBe(`${BASE}/epoch_params?order=epoch_no.desc&limit=1`)
  })

  it('accepts lovelace values delivered as numbers, not just strings', async () => {
    const numericRows = [
      { ...EPOCH_PARAM_ROWS[0], key_deposit: 2_000_000, coins_per_utxo_size: 4310 },
    ]
    const { fetchImpl } = fakeFetch({ json: async () => numericRows })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const params = await provider.getProtocolParams()

    expect(params.keyDeposit).toBe('2000000')
    expect(params.coinsPerUtxoByte).toBe('4310')
  })

  it('defaults cost models to an empty object when Koios returns null', async () => {
    const rows = [{ ...EPOCH_PARAM_ROWS[0], cost_models: null }]
    const { fetchImpl } = fakeFetch({ json: async () => rows })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const params = await provider.getProtocolParams()

    expect(params.costModels).toEqual({})
  })

  it('strips a trailing slash from the base url', async () => {
    const { fetchImpl, urls } = fakeFetch({ json: async () => TIP_ROWS })
    const provider = createKoiosProvider({ baseUrl: `${BASE}/`, fetchImpl })

    await provider.getTip()

    expect(urls[0]).toBe(`${BASE}/tip`)
  })
})

describe('koios provider — unhappy path', () => {
  it('throws ProviderError with the upstream status on a non-2xx response', async () => {
    const { fetchImpl } = fakeFetch({ ok: false, status: 503, text: async () => 'busy' })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTip()).rejects.toMatchObject({
      name: 'ProviderError',
      upstreamStatus: 503,
    })
  })

  it('wraps a network failure in ProviderError', async () => {
    const { fetchImpl } = fakeFetch({ throws: new Error('ECONNREFUSED') })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderError)
  })

  it('maps an AbortSignal timeout to ProviderTimeoutError', async () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    const { fetchImpl } = fakeFetch({ throws: timeout })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderTimeoutError)
  })

  it('throws MalformedUpstreamError when the body is not valid json', async () => {
    const { fetchImpl } = fakeFetch({
      json: async () => {
        throw new Error('unexpected token')
      },
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('throws MalformedUpstreamError when Koios returns an empty array', async () => {
    const { fetchImpl } = fakeFetch({ json: async () => [] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('throws MalformedUpstreamError when a required field is missing', async () => {
    const rows = [{ hash: 'deadbeef', epoch_no: 199 }] // no abs_slot / block_no
    const { fetchImpl } = fakeFetch({ json: async () => rows })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects a non-numeric protocol-param value as malformed', async () => {
    const rows = [{ ...EPOCH_PARAM_ROWS[0], key_deposit: 'not-a-number' }]
    const { fetchImpl } = fakeFetch({ json: async () => rows })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getProtocolParams()).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects a negative numeric protocol-param value as malformed', async () => {
    const rows = [{ ...EPOCH_PARAM_ROWS[0], key_deposit: -5 }]
    const { fetchImpl } = fakeFetch({ json: async () => rows })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getProtocolParams()).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('throws MalformedUpstreamError when Koios returns a non-array body', async () => {
    const { fetchImpl } = fakeFetch({ json: async () => ({ unexpected: 'object' }) })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('maps a timeout during body parsing to ProviderTimeoutError', async () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    const { fetchImpl } = fakeFetch({
      json: async () => {
        throw timeout
      },
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderTimeoutError)
  })
})

describe('koios provider — upstream value integrity', () => {
  const TX_HASH = 'a'.repeat(64)

  it('rejects a lovelace amount that JSON.parse already rounded past 2^53', async () => {
    // Koios sends large amounts as strings. If one ever arrives as a JSON number above
    // 2^53 it is corrupt before any schema sees it, and stringifying it back out would
    // report a wrong-but-plausible balance as fact. Refuse it instead.
    //
    // Parsed from raw JSON rather than written as a literal, because that is how it would
    // actually reach us, and because a literal this size is itself a lint error: eslint's
    // no-loss-of-precision rule refuses to let the exact bug under test be typed by hand.
    const body = JSON.parse(
      '[{"stake_address":"stake_test1abc","status":"registered",' +
        '"total_balance":7682048683977123456,' +
        '"rewards_available":0,"rewards":0,"withdrawals":0}]',
    ) as Array<{ total_balance: number }>
    expect(Number.isSafeInteger(body[0]?.total_balance)).toBe(false)

    const { fetchImpl } = fakeFetch({ json: async () => body })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getAccountState('stake_test1abc')).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })

  it('still accepts a large lovelace amount sent as a string, digit for digit', async () => {
    const { fetchImpl } = fakeFetch({
      json: async () => [
        {
          stake_address: 'stake_test1abc',
          status: 'registered',
          total_balance: '7682048683977123456',
          rewards_available: '0',
          rewards: '0',
          withdrawals: '0',
        },
      ],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const state = await provider.getAccountState('stake_test1abc')
    expect(state.balance).toBe('7682048683977123456')
  })

  it('does not report another transaction’s confirmations as this one’s', async () => {
    // A mismatched tx_status row must not be read as the requested tx, or a wallet would
    // tell someone a payment landed when it did not.
    const { fetchImpl } = fakeFetch({
      json: async () => [{ tx_hash: 'b'.repeat(64), num_confirmations: 12 }],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxStatus(TX_HASH)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('reports an unseen transaction as unseen when tx_status is empty', async () => {
    const { fetchImpl } = fakeFetch({ json: async () => [] })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxStatus(TX_HASH)).resolves.toEqual({
      seen: false,
      confirmations: 0,
    })
  })

  it('rejects a negative confirmation count', async () => {
    const { fetchImpl } = fakeFetch({
      json: async () => [{ tx_hash: TX_HASH, num_confirmations: -3 }],
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getTxStatus(TX_HASH)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})

describe('koios provider — asset identifiers', () => {
  const utxoWith = (policyId: string, assetName: string) => [
    {
      tx_hash: 'aa',
      tx_index: 0,
      address: 'addr_test1',
      value: '2000000',
      asset_list: [{ policy_id: policyId, asset_name: assetName, quantity: '1' }],
    },
  ]

  it.each([
    ['empty', ''],
    ['one byte', '00'],
    ['even length', '414243'],
    ['mixed case', 'aB12Cd'],
    ['32 bytes', 'ab'.repeat(32)],
  ])('accepts a %s asset name and preserves its spelling', async (_case, assetName) => {
    // A policy's unnamed asset is valid on chain, so the boundary must not demand a name.
    const policyId = 'a'.repeat(56)
    const { fetchImpl } = fakeFetch({ json: async () => utxoWith(policyId, assetName) })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [utxo] = await provider.getAccountUtxos('stake_test1abc')

    expect(utxo?.assets).toEqual([{ policyId, assetName, quantity: '1' }])
  })

  it.each([
    ['odd length', 'a'],
    ['non-hex', '0g'],
    ['over 32 bytes', 'ab'.repeat(33)],
  ])('rejects a %s asset name as malformed upstream data', async (_case, assetName) => {
    const { fetchImpl } = fakeFetch({ json: async () => utxoWith('a'.repeat(56), assetName) })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })

    await expect(provider.getAccountUtxos('stake_test1abc')).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })

  it('rejects an empty policy id, which is never valid', async () => {
    const { fetchImpl } = fakeFetch({ json: async () => utxoWith('', '4142') })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getAccountUtxos('stake_test1abc')).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })
})
