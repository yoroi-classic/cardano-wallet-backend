import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { MalformedUpstreamError, ProviderError } from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'
const STAKE = 'stake1ux3g2c9dx2nhhehyrezyxpkstartcqmu9hk63qgfkccw5rqttygt7'

// Copied from Blockfrost's OpenAPI spec examples for `account_content`.
const ACCOUNT_ROW = {
  stake_address: STAKE,
  active: true,
  registered: true,
  active_epoch: 412,
  controlled_amount: '619154618165',
  rewards_sum: '319154618165',
  withdrawals_sum: '12125369253',
  reserves_sum: '0',
  treasury_sum: '0',
  withdrawable_amount: '306529248912',
  pool_id: 'pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy',
  drep_id: 'drep15cfxz9exyn5rx0807zvxfrvslrjqfchrd4d47kv9e0f46uedqtc',
}

const ADDRESS =
  'addr1qxqs59lphg8g6qndelq8xwqn60ag3aeyfcp33c2kdp46a09re5df3pzwwmyq946axfcejy5n4x0y99wqpgtp2gd0k09qsgy6pz'

// Copied from Blockfrost's OpenAPI spec examples for `account_utxo_content`.
function utxoRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: ADDRESS,
    tx_hash: '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
    output_index: 0,
    amount: [{ unit: 'lovelace', quantity: '42000000' }],
    block: '7eb8e27d18686c7db9a18f8bbcfe34e3fed6e047afaa2d969904d15e934847e6',
    data_hash: null,
    inline_datum: null,
    reference_script_hash: null,
    ...overrides,
  }
}

/** Scripts one JSON response per call to a given path, repeating the last one after that. */
function scriptedFetch(script: Record<string, unknown[]>): {
  fetchImpl: FetchLike
  calls: string[]
} {
  const served = new Map<string, number>()
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url)
    const path = Object.keys(script).find((p) => url.includes(p))
    if (path === undefined) throw new Error(`test script has no answer for ${url}`)
    const answers = script[path] as unknown[]
    const nth = served.get(path) ?? 0
    served.set(path, nth + 1)
    const answer = answers[Math.min(nth, answers.length - 1)]
    if (answer && typeof answer === 'object' && 'status' in answer) {
      const a = answer as { status: number }
      return { ok: a.status < 400, status: a.status, json: async () => ({}), text: async () => '' }
    }
    return { ok: true, status: 200, json: async () => answer, text: async () => '' }
  }
  return { fetchImpl, calls }
}

function testProvider(script: Record<string, unknown[]>) {
  const { fetchImpl } = scriptedFetch(script)
  return createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })
}

describe('blockfrost account — happy path', () => {
  it('getAccountState maps a registered account (regression)', async () => {
    const provider = testProvider({ [`/accounts/${STAKE}`]: [ACCOUNT_ROW] })

    const state = await provider.getAccountState(STAKE)

    expect(state).toEqual({
      stakeAddress: STAKE,
      registered: true,
      balance: '619154618165',
      rewardsAvailable: '306529248912',
      rewardsSum: '319154618165',
      withdrawalsSum: '12125369253',
      delegatedPool: 'pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy',
      delegatedDrep: 'drep15cfxz9exyn5rx0807zvxfrvslrjqfchrd4d47kv9e0f46uedqtc',
    })
  })

  it('getAccountState reports an unregistered, zero-balance account on a 404', async () => {
    const provider = testProvider({ [`/accounts/${STAKE}`]: [{ status: 404 }] })

    await expect(provider.getAccountState(STAKE)).resolves.toEqual({
      stakeAddress: STAKE,
      registered: false,
      balance: '0',
      rewardsAvailable: '0',
      rewardsSum: '0',
      withdrawalsSum: '0',
    })
  })

  it('getAccountUtxos maps one page of utxos, splitting lovelace from native assets', async () => {
    // A synthetic but well-formed unit: a 56-hex-char (28-byte) policy id, the length a real
    // Blake2b-224 script hash always is, followed by the hex asset name with no separator —
    // exactly the concatenation Blockfrost's spec describes.
    const policyId = 'c'.repeat(56)
    const assetName = '6e7574636f696e' // "nutcoin"
    const assetUtxo = utxoRow({
      tx_hash: '768c63e27a1c816a83dc7b07e78af673b2400de8849ea7e7b734ae1333d100d2',
      output_index: 1,
      amount: [
        { unit: 'lovelace', quantity: '42000000' },
        { unit: `${policyId}${assetName}`, quantity: '12' },
      ],
    })
    const { fetchImpl, calls } = scriptedFetch({
      [`/accounts/${STAKE}/utxos`]: [[utxoRow(), assetUtxo]],
    })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    const utxos = await provider.getAccountUtxos(STAKE)

    expect(utxos).toEqual([
      {
        txHash: '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
        outputIndex: 0,
        address: ADDRESS,
        value: '42000000',
        assets: [],
      },
      {
        txHash: '768c63e27a1c816a83dc7b07e78af673b2400de8849ea7e7b734ae1333d100d2',
        outputIndex: 1,
        address: ADDRESS,
        value: '42000000',
        assets: [{ policyId, assetName, quantity: '12' }],
      },
    ])
    expect(calls).toHaveLength(1)
  })

  it('preserves the accepted hex casing of a native-asset unit in provider output', async () => {
    const policyId = 'aB'.repeat(28)
    const assetName = 'DeAd'
    const provider = testProvider({
      [`/accounts/${STAKE}/utxos`]: [
        [
          utxoRow({
            amount: [
              { unit: 'lovelace', quantity: '42000000' },
              { unit: `${policyId}${assetName}`, quantity: '12' },
            ],
          }),
        ],
      ],
    })

    const [utxo] = await provider.getAccountUtxos(STAKE)

    expect(utxo?.assets).toEqual([{ policyId, assetName, quantity: '12' }])
  })

  it('getAccountUtxos reports no utxos, not an error, for a never-used account', async () => {
    const provider = testProvider({ [`/accounts/${STAKE}/utxos`]: [{ status: 404 }] })

    await expect(provider.getAccountUtxos(STAKE)).resolves.toEqual([])
  })

  it('getAccountUtxos pages until a short page ends the walk', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      utxoRow({ tx_hash: `${i}`.padStart(64, '0'), output_index: 0 }),
    )
    const shortPage = [utxoRow({ tx_hash: 'b'.repeat(64), output_index: 2 })]
    const provider = testProvider({
      [`/accounts/${STAKE}/utxos`]: [fullPage, shortPage, fullPage, shortPage],
    })

    const utxos = await provider.getAccountUtxos(STAKE)

    expect(utxos).toHaveLength(101)
    expect(utxos[100]?.txHash).toBe('b'.repeat(64))
  })
})

describe('blockfrost account — paged UTxO consistency', () => {
  const rows = (from: number, toInclusive: number): Record<string, unknown>[] =>
    Array.from({ length: toInclusive - from + 1 }, (_value, offset) =>
      utxoRow({ tx_hash: `${from + offset}`.padStart(64, '0'), output_index: 0 }),
    )

  function sequencedProvider(pageRows: unknown[]): {
    provider: ReturnType<typeof createBlockfrostProvider>
    calls: string[]
  } {
    const { fetchImpl, calls } = scriptedFetch({ [`/accounts/${STAKE}/utxos`]: pageRows })
    return {
      provider: createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl }),
      calls,
    }
  }

  it('retries a deletion-shifted gap and returns only two matching complete scans', async () => {
    const oldFirstPage = rows(0, 99)
    const currentFirstPage = rows(1, 100)
    const currentLastPage = rows(101, 101)
    const { provider, calls } = sequencedProvider([
      // Output 0 is spent after page one. Offset 100 now skips output 100.
      oldFirstPage,
      currentLastPage,
      // The next two complete walks see the stable current set and may be returned.
      currentFirstPage,
      currentLastPage,
      currentFirstPage,
      currentLastPage,
    ])

    const utxos = await provider.getAccountUtxos(STAKE)

    expect(utxos).toHaveLength(101)
    expect(utxos[0]?.txHash).toBe('1'.padStart(64, '0'))
    expect(utxos[100]?.txHash).toBe('101'.padStart(64, '0'))
    expect(calls).toHaveLength(6)
    expect(calls.every((url) => url.includes('order=asc'))).toBe(true)
  })

  it('fails closed after three continuously changing complete scans', async () => {
    const { provider, calls } = sequencedProvider([
      rows(0, 99),
      rows(100, 100),
      rows(1, 100),
      rows(101, 101),
      rows(2, 101),
      rows(102, 102),
    ])

    await expect(provider.getAccountUtxos(STAKE)).rejects.toThrow(
      'blockfrost account utxos changed during paged read; retry',
    )
    expect(calls).toHaveLength(6)
  })

  it('never accepts matching scans that duplicate an output across a page boundary', async () => {
    const firstPage = rows(0, 99)
    const duplicatedBoundary = rows(99, 100)
    const { provider, calls } = sequencedProvider([
      firstPage,
      duplicatedBoundary,
      firstPage,
      duplicatedBoundary,
      firstPage,
      duplicatedBoundary,
    ])

    const error = await provider.getAccountUtxos(STAKE).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderError)
    expect(String(error)).not.toContain(STAKE)
    expect(String(error)).not.toContain('0'.repeat(64))
    expect(calls).toHaveLength(6)
  })
})

describe('blockfrost account — unhappy path', () => {
  it('throws MalformedUpstreamError when a required account field is missing', async () => {
    const broken: Record<string, unknown> = { ...ACCOUNT_ROW }
    delete broken.registered
    const provider = testProvider({ [`/accounts/${STAKE}`]: [broken] })

    await expect(provider.getAccountState(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects a lovelace amount that JSON.parse already rounded past 2^53', async () => {
    const body = JSON.parse(
      `{"stake_address":"${STAKE}","registered":true,` +
        '"controlled_amount":7682048683977123456,"rewards_sum":0,"withdrawals_sum":0,' +
        '"withdrawable_amount":0,"pool_id":null,"drep_id":null}',
    ) as { controlled_amount: number }
    expect(Number.isSafeInteger(body.controlled_amount)).toBe(false)
    const provider = testProvider({ [`/accounts/${STAKE}`]: [body] })

    await expect(provider.getAccountState(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('throws MalformedUpstreamError when a utxo amount has no lovelace unit', async () => {
    const tokenOnly = utxoRow({
      amount: [
        {
          unit: 'b0d07d45fe9514f80213f4020e5a61241458be626841cde717cb38a76e7574636f696e',
          quantity: '12',
        },
      ],
    })
    const provider = testProvider({ [`/accounts/${STAKE}/utxos`]: [[tokenOnly]] })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('throws ProviderError when the utxo set exceeds the scan bound', async () => {
    // 51 full pages in a row: the walk gives up after 50 and probes, and the probe still comes
    // back non-empty, so this really is truncated rather than landing exactly on a boundary.
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      utxoRow({ tx_hash: `${i}`.padStart(64, '0') }),
    )
    const provider = testProvider({
      [`/accounts/${STAKE}/utxos`]: Array.from({ length: 51 }, () => fullPage),
    })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toBeInstanceOf(ProviderError)
  })

  it.each([
    ['a policy id shorter than 56 hex chars', 'a'.repeat(54)],
    ['a non-hex character in the policy id', 'g'.repeat(56)],
    ['an odd-length asset name', `${'a'.repeat(56)}abc`],
    ['an asset name longer than 64 hex chars', `${'a'.repeat(56)}${'ab'.repeat(33)}`],
  ])('rejects a utxo unit with %s as malformed', async (_desc, unit) => {
    const bad = utxoRow({
      amount: [
        { unit: 'lovelace', quantity: '1000000' },
        { unit, quantity: '5' },
      ],
    })
    const provider = testProvider({ [`/accounts/${STAKE}/utxos`]: [[bad]] })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects a duplicate native-asset unit rather than exposing both', async () => {
    const unit = `${'a'.repeat(56)}6e7574636f696e`
    const dup = utxoRow({
      amount: [
        { unit: 'lovelace', quantity: '1000000' },
        { unit, quantity: '5' },
        { unit, quantity: '7' },
      ],
    })
    const provider = testProvider({ [`/accounts/${STAKE}/utxos`]: [[dup]] })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('rejects case-variant encodings of the same native-asset unit as duplicates', async () => {
    const lowercaseUnit = `${'ab'.repeat(28)}6e7574636f696e`
    const dup = utxoRow({
      amount: [
        { unit: 'lovelace', quantity: '1000000' },
        { unit: lowercaseUnit, quantity: '5' },
        { unit: lowercaseUnit.toUpperCase(), quantity: '7' },
      ],
    })
    const provider = testProvider({ [`/accounts/${STAKE}/utxos`]: [[dup]] })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it.each([
    ['lowercase then uppercase', false],
    ['uppercase then lowercase', true],
  ])('rejects case-variant native-asset units across UTxO rows (%s)', async (_order, reversed) => {
    const lowercaseUnit = `${'ab'.repeat(28)}6e7574636f696e`
    const units = reversed
      ? [lowercaseUnit.toUpperCase(), lowercaseUnit]
      : [lowercaseUnit, lowercaseUnit.toUpperCase()]
    const rows = units.map((unit, index) =>
      utxoRow({
        tx_hash: `${index + 1}`.padStart(64, '0'),
        amount: [
          { unit: 'lovelace', quantity: '1000000' },
          { unit, quantity: String(index + 5) },
        ],
      }),
    )
    const provider = testProvider({ [`/accounts/${STAKE}/utxos`]: [rows] })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('allows the same native-asset spelling in separate UTxO rows', async () => {
    const unit = `${'ab'.repeat(28)}6e7574636f696e`
    const rows = [0, 1].map((index) =>
      utxoRow({
        tx_hash: `${index + 1}`.padStart(64, '0'),
        amount: [
          { unit: 'lovelace', quantity: '1000000' },
          { unit, quantity: String(index + 5) },
        ],
      }),
    )
    const provider = testProvider({ [`/accounts/${STAKE}/utxos`]: [rows] })

    await expect(provider.getAccountUtxos(STAKE)).resolves.toHaveLength(2)
  })

  it('rejects a second lovelace entry rather than letting it overwrite the real ada value', async () => {
    const dup = utxoRow({
      amount: [
        { unit: 'lovelace', quantity: '42000000' },
        { unit: 'lovelace', quantity: '0' },
      ],
    })
    const provider = testProvider({ [`/accounts/${STAKE}/utxos`]: [[dup]] })

    await expect(provider.getAccountUtxos(STAKE)).rejects.toBeInstanceOf(MalformedUpstreamError)
  })
})

describe('blockfrost account — utxo scan boundary', () => {
  // A fake that paginates for real: it honours the `count` and `page` query params the driver
  // sends, so an off-by-one in the probe's offset is visible here the way it is against the live
  // API. `total` is how many UTxOs the account holds.
  function paginatingProvider(total: number): ReturnType<typeof createBlockfrostProvider> {
    const fetchImpl: FetchLike = async (url) => {
      const parsed = new URL(url)
      const count = Number(parsed.searchParams.get('count') ?? '100')
      const page = Number(parsed.searchParams.get('page') ?? '1')
      const offset = (page - 1) * count
      const rows = Array.from({ length: Math.max(0, Math.min(count, total - offset)) }, (_v, i) =>
        utxoRow({ tx_hash: `${offset + i}`.padStart(64, '0'), output_index: 0 }),
      )
      return { ok: true, status: 200, json: async () => rows, text: async () => '' }
    }
    return createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })
  }

  it('returns the full set for an account holding exactly 5000 utxos', async () => {
    const utxos = await paginatingProvider(5000).getAccountUtxos(STAKE)

    expect(utxos).toHaveLength(5000)
  })

  it('rejects an account holding one more utxo than the scan bound', async () => {
    await expect(paginatingProvider(5001).getAccountUtxos(STAKE)).rejects.toBeInstanceOf(
      ProviderError,
    )
  })
})
