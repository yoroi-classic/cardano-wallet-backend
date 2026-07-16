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
function scriptedFetch(script: Record<string, unknown[]>): { fetchImpl: FetchLike } {
  const served = new Map<string, number>()
  const fetchImpl: FetchLike = async (url) => {
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
  return { fetchImpl }
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
    const provider = testProvider({
      [`/accounts/${STAKE}/utxos`]: [[utxoRow(), assetUtxo]],
    })

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
    const provider = testProvider({ [`/accounts/${STAKE}/utxos`]: [fullPage, shortPage] })

    const utxos = await provider.getAccountUtxos(STAKE)

    expect(utxos).toHaveLength(101)
    expect(utxos[100]?.txHash).toBe('b'.repeat(64))
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
})
