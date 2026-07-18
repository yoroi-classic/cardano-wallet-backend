import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { bech32 } from '@scure/base'
import { describe, expect, it } from 'vitest'
import { openapi } from '../../src/http/openapi.js'
import { buildServer } from '../../src/http/server.js'
import { createNftcdnSigner } from '../../src/media/nftcdn.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import { fakeProvider } from '../support/fake-provider.js'

/**
 * These two tests are what make the spec worth having.
 *
 * A hand-written API document normally rots. The code moves, the document does not, and it
 * quietly becomes a lie that is worse than no document at all, because people trust it and build
 * against it. So the spec is checked against the implementation rather than merely describing it:
 * one test asserts it covers exactly the routes that exist, the other validates real responses,
 * from the real handlers, against the schemas it publishes.
 */

const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats.default(ajv)
ajv.addSchema({ ...openapi.components, $id: 'components' })

/** Validate a value against a named schema from the spec. */
function validate(schemaName: string, value: unknown): string[] {
  const schema = {
    $ref: `#/components/schemas/${schemaName}`,
    components: openapi.components,
  }
  const check = ajv.compile(schema)
  return check(value) ? [] : (check.errors ?? []).map((e) => `${e.instancePath} ${e.message}`)
}

// Well-formed bech32, so the routes' own validation passes and the responses under test are the
// real ones rather than a 400.
const STAKE = bech32.encode('stake_test', bech32.toWords(new Uint8Array(29)), 1023)
const ADDR = (fill: number): string =>
  bech32.encode('addr_test', bech32.toWords(new Uint8Array(57).fill(fill)), 1023)
const TX_HASH = 'ab'.repeat(32)
const POLICY = 'a'.repeat(56)
const POOL = 'pool1wn6a6f23ctq06udwhw27ravdpd6zcr7jlut3yez0wzdackz3222'
const DREP = 'drep1ygpuetneftlmufa97hm5mf3xvqpdkyw656hyg6h20qaewtg3csnkc'

/**
 * The routes Fastify actually serves, as `METHOD /path` with path parameters normalized.
 *
 * Parsed out of the route tree, because that is the only place the truth lives: it is what the
 * server will actually answer, rather than what a source file claims it registers. HEAD and
 * OPTIONS are dropped (Fastify adds them for free, and no one documents them). A parameter's name
 * is normalized away, because the route calls it `:stake` and the spec calls it `{stakeAddress}`,
 * and that difference is cosmetic: what matters is that a segment is a parameter in both.
 */
function servedRoutes(app: Awaited<ReturnType<typeof buildServer>>): Set<string> {
  const routes = new Set<string>()
  const prefix: string[] = []

  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const marker = line.search(/[└├]/)
    if (marker < 0) continue

    // Each level of the tree is indented four columns, and the tree nests a shared prefix
    // (/v1/pools and its /info child), so a segment has to be joined onto its parent.
    const depth = Math.floor(marker / 4)
    const parsed = /^(\S*)\s*\(([^)]+)\)/.exec(line.slice(marker + 4))
    if (parsed === null) continue

    prefix.length = depth
    prefix[depth] = parsed[1] ?? ''
    const path = prefix.slice(0, depth + 1).join('')

    for (const method of (parsed[2] ?? '').split(',').map((m) => m.trim())) {
      if (method === 'HEAD' || method === 'OPTIONS') continue
      routes.add(`${method} ${normalizeParams(path)}`)
    }
  }
  return routes
}

/** `/v1/account/:stake/state` and `/v1/account/{stakeAddress}/state` both become `/v1/account/{}/state`. */
function normalizeParams(path: string): string {
  return path.replace(/:[^/]+/g, '{}').replace(/\{[^}]+\}/g, '{}')
}

describe('the spec covers exactly what the server serves', () => {
  // The drift guard, and the reason this spec is worth trusting. Add an endpoint and forget to
  // document it, or document one that does not exist, and this fails. Without it the spec is a
  // snapshot of one afternoon's intentions, and the client authors building against it find out
  // the hard way.
  it('documents every registered route, and no route that is not registered', async () => {
    const app = await buildServer({ provider: fakeProvider() })
    await app.ready()
    const served = servedRoutes(app)
    await app.close()

    const documented = new Set<string>()
    for (const [path, operations] of Object.entries(openapi.paths)) {
      for (const method of Object.keys(operations)) {
        documented.add(`${method.toUpperCase()} ${normalizeParams(path)}`)
      }
    }

    const undocumented = [...served].filter((r) => !documented.has(r)).sort()
    const phantom = [...documented].filter((r) => !served.has(r)).sort()

    expect({ undocumented, phantom }).toEqual({ undocumented: [], phantom: [] })
  })
})

describe('real responses validate against the schemas the spec publishes', () => {
  async function call(
    provider: Partial<ChainProvider>,
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
  ): Promise<{ statusCode: number; body: unknown }> {
    const app = await buildServer({ provider: fakeProvider(provider) })
    const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
    await app.close()
    return { statusCode: res.statusCode, body: res.json() }
  }

  const get = (provider: Partial<ChainProvider>, url: string) => call(provider, 'GET', url)
  const post = (provider: Partial<ChainProvider>, url: string, payload: object) =>
    call(provider, 'POST', url, payload)

  /** Every item of an array response, validated against one schema. */
  function eachMatches(schema: string, body: unknown): void {
    expect(Array.isArray(body)).toBe(true)
    for (const item of body as unknown[]) expect(validate(schema, item)).toEqual([])
  }

  it('GET /v1/chain/tip', async () => {
    const tip = {
      block: 3_500_000,
      slot: 86_400_123,
      epoch: 199,
      hash: 'aa'.repeat(32),
      blockTime: 1_700_000_000,
    }
    const res = await get({ getTip: async () => tip }, '/v1/chain/tip')

    expect(res.statusCode).toBe(200)
    expect(validate('Tip', res.body)).toEqual([])
  })

  it('GET /v1/account/{stake}/state', async () => {
    const state = {
      stakeAddress: STAKE,
      registered: true,
      balance: '9999999999999999999', // over 2^53 on purpose: it must be a string, not a number
      rewardsAvailable: '250000',
      rewardsSum: '900000',
      withdrawalsSum: '650000',
      delegatedPool: POOL,
      delegatedDrep: DREP,
    }
    const res = await get({ getAccountState: async () => state }, `/v1/account/${STAKE}/state`)

    expect(res.statusCode).toBe(200)
    expect(validate('AccountState', res.body)).toEqual([])
    // The precision claim in the spec, made good: it survives the round trip as digits.
    expect((res.body as { balance: string }).balance).toBe('9999999999999999999')
  })

  it('GET /v1/account/{stake}/utxos', async () => {
    const utxo = {
      txHash: TX_HASH,
      outputIndex: 0,
      address: 'addr_test1xyz',
      value: '2000000',
      assets: [{ policyId: POLICY, assetName: '414243', quantity: '5' }],
      inlineDatum: 'd87980',
    }
    const res = await get({ getAccountUtxos: async () => [utxo] }, `/v1/account/${STAKE}/utxos`)

    expect(res.statusCode).toBe(200)
    eachMatches('Utxo', res.body)
  })

  it('GET /v1/account/{stake}/txs', async () => {
    const tx = {
      txHash: TX_HASH,
      block: 1_000,
      blockHash: 'bb'.repeat(32),
      slot: 5_000,
      epoch: 10,
      blockTime: 1_700_000_000,
      fee: '170000',
      inputs: [{ address: 'addr_test1a', value: '1000000', assets: [] }],
      outputs: [{ address: 'addr_test1b', value: '830000', assets: [] }],
      withdrawals: [{ stakeAddress: STAKE, amount: '1' }],
      certificates: [{ kind: 'vote_delegation' as const, index: 0 }],
    }
    const res = await get({ getTxHistory: async () => [tx] }, `/v1/account/${STAKE}/txs`)

    expect(res.statusCode).toBe(200)
    eachMatches('WalletTransaction', res.body)
  })

  it('GET /v1/tx/{hash}/status', async () => {
    const res = await get(
      { getTxStatus: async () => ({ seen: true, confirmations: 12 }) },
      `/v1/tx/${TX_HASH}/status`,
    )

    expect(res.statusCode).toBe(200)
    expect(validate('TxStatus', res.body)).toEqual([])
  })

  it('POST /v1/assets/info', async () => {
    const token = {
      subject: POLICY + '484f534b59',
      policyId: POLICY,
      assetName: '484f534b59',
      assetNameAscii: 'HOSKY',
      fingerprint: 'asset17q7r59zlc3dgw0venc80pdv566q6yguw03f0d9',
      supply: '1000000000000001',
      source: 'registry' as const,
      name: 'HOSKY Token',
      ticker: 'HOSKY',
      decimals: 0,
    }
    const res = await post({ getTokenMetadata: async () => [token] }, '/v1/assets/info', {
      subjects: [token.subject],
    })

    expect(res.statusCode).toBe(200)
    eachMatches('TokenMetadata', res.body)
  })

  it('POST /v1/pools/info', async () => {
    const pool = {
      poolId: POOL,
      poolIdHex: 'cc'.repeat(28),
      status: 'registered' as const,
      margin: 0.03,
      fixedCost: '170000000',
      pledge: '1000000000',
      livePledge: '1000000000',
      activeStake: '7682048683977123456', // over 2^53 on purpose
      liveStake: '7682048683977123456',
      saturation: 0.42,
      liveDelegators: 1_200,
      blocksMinted: 5_000,
      metadata: { name: 'A pool', ticker: 'POOL' },
    }
    const res = await post({ getPoolInfo: async () => [pool] }, '/v1/pools/info', {
      poolIds: [POOL],
    })

    expect(res.statusCode).toBe(200)
    eachMatches('PoolInfo', res.body)
    expect((res.body as { activeStake: string }[])[0]?.activeStake).toBe('7682048683977123456')
  })

  it('GET /v1/pools', async () => {
    const pool = {
      poolId: POOL,
      poolIdHex: 'cc'.repeat(28),
      status: 'retiring' as const,
      retiringEpoch: 500,
      margin: 0,
      fixedCost: '170000000',
      pledge: '0',
      livePledge: '0',
      activeStake: '0',
      liveStake: '0',
      saturation: 0,
      liveDelegators: 0,
      blocksMinted: 0,
    }
    const res = await get({ getPoolList: async () => [pool] }, '/v1/pools?limit=1')

    expect(res.statusCode).toBe(200)
    eachMatches('PoolInfo', res.body)
  })

  it('POST /v1/governance/dreps/info', async () => {
    const drep = {
      drepId: DREP,
      hex: '03ccae794affbe27a5f5f74da6266002db11daa6ae446aea783b972d',
      hasScript: false,
      status: 'not_registered' as const,
      active: false,
      deposit: '0',
      votingPower: '0',
    }
    const res = await post({ getDrepInfo: async () => [drep] }, '/v1/governance/dreps/info', {
      drepIds: [DREP],
    })

    expect(res.statusCode).toBe(200)
    eachMatches('DrepInfo', res.body)
  })

  it('POST /v1/addresses/filter-used', async () => {
    const res = await post(
      { filterUsedAddresses: async (a: string[]) => a.slice(0, 1) },
      '/v1/addresses/filter-used',
      { addresses: [ADDR(1), ADDR(2)] },
    )

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual([ADDR(1)])
  })

  it('POST /v1/tx/submit', async () => {
    const res = await post({ submitTx: async () => ({ txHash: TX_HASH }) }, '/v1/tx/submit', {
      cbor: '84a400818258',
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ txHash: TX_HASH })
  })

  it('GET /v1/status', async () => {
    const res = await get(
      {
        getTip: async () => ({
          block: 3_500_000,
          slot: 86_400_123,
          epoch: 199,
          hash: 'aa'.repeat(32),
          blockTime: Math.floor(Date.now() / 1000) - 20,
        }),
      },
      '/v1/status',
    )

    expect(res.statusCode).toBe(200)
    expect(validate('Status', res.body)).toEqual([])
  })

  // A `chain: "down"` still comes back as a 200, and the schema has to allow a null tip, or a
  // client validating against the spec would reject the exact response it needs most.
  it('GET /v1/status when the chain source is unreachable', async () => {
    const res = await get(
      {
        getTip: async () => {
          throw new Error('koios is unreachable')
        },
      },
      '/v1/status',
    )

    expect(res.statusCode).toBe(200)
    expect(validate('Status', res.body)).toEqual([])
    expect((res.body as { chain: string }).chain).toBe('down')
  })

  it('GET /v1/account/{stake}/rewards', async () => {
    const res = await get(
      {
        getRewardHistory: async () => [
          {
            earnedEpoch: 30,
            spendableEpoch: 32,
            amount: '390098844',
            kind: 'member' as const,
            poolId: POOL,
          },
          // A treasury payout has no pool, so poolId is absent rather than an empty string.
          { earnedEpoch: 31, spendableEpoch: 33, amount: '1', kind: 'treasury' as const },
        ],
      },
      `/v1/account/${STAKE}/rewards`,
    )

    expect(res.statusCode).toBe(200)
    eachMatches('AccountReward', res.body)
  })

  it('POST /v1/tx/utxos', async () => {
    const res = await post(
      {
        getUtxosByRef: async () => [
          {
            txHash: TX_HASH,
            outputIndex: 0,
            address: 'addr_test1x',
            value: '9999999999999999999', // over 2^53 on purpose
            assets: [{ policyId: POLICY, assetName: '', quantity: '1' }],
            spent: true,
          },
        ],
      },
      '/v1/tx/utxos',
      { refs: [`${TX_HASH}#0`] },
    )

    expect(res.statusCode).toBe(200)
    eachMatches('ResolvedUtxo', res.body)
    // The field the endpoint exists for, and the one the spec tells clients to check before
    // using an output as collateral.
    expect((res.body as { spent: boolean }[])[0]?.spent).toBe(true)
  })

  it('GET /v1/governance/proposals', async () => {
    const res = await get(
      {
        getProposals: async () => [
          {
            proposalId: 'gov_action1jr0g04rwvdz3rrqpm30vwqd5mnjky8l68v0e3g74t6e5apw6wwfqq37hpcl',
            txHash: TX_HASH,
            index: 0,
            type: 'TreasuryWithdrawals' as const,
            status: 'open' as const,
            proposedEpoch: 297,
            expiryEpoch: 304,
            deposit: '100000000000',
            returnAddress: STAKE,
            title: 'A proposal',
            metadataValid: true,
            drepVotes: {
              yes: 1,
              no: 0,
              abstain: 0,
              // Voting power is lovelace and exceeds 2^53: it must survive as digits.
              yesPower: '9999999999999999999',
              noPower: '0',
              abstainPower: '0',
            },
          },
        ],
      },
      '/v1/governance/proposals',
    )

    expect(res.statusCode).toBe(200)
    eachMatches('Proposal', res.body)
    expect((res.body as { drepVotes: { yesPower: string } }[])[0]?.drepVotes.yesPower).toBe(
      '9999999999999999999',
    )
  })

  it('POST /v1/assets/media', async () => {
    const app = await buildServer({
      provider: fakeProvider(),
      nftcdn: createNftcdnSigner({
        subdomain: 'preprod',
        secretKeyBase64: '7FoxfBgV2k+RSz6UUts3/fG1edG7oIGXxdtIVCdalaI=',
      }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/assets/media',
      payload: { fingerprints: ['asset1cpfcfxay6s73xez8srvhf0pydtd9yqs8hyfawv'], size: 720 },
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    eachMatches('AssetMedia', res.json())
    // The spec says the response reports the size *actually served*, and that 720 is not one the
    // provider has. If that stopped being true, a client laying out against `size` would be wrong.
    expect(res.json()[0].size).toBe(1024)
  })

  // The price surface has no 200 to validate, which is the point of it. What must hold is that its
  // 501 is the same error envelope as everything else, so an adapter needs no special case.
  it.each([
    ['GET', '/v1/price/ada?currencies=USD', undefined],
    ['POST', '/v1/price/tokens', { subjects: [POLICY] }],
  ])('%s %s answers the documented 501 envelope', async (method, url, payload) => {
    const res = await call({}, method as 'GET' | 'POST', url, payload)

    expect(res.statusCode).toBe(501)
    expect(validate('Error', res.body)).toEqual([])
    expect((res.body as { error: { code: string } }).error.code).toBe('NOT_IMPLEMENTED')
  })

  // Distinct from the 501 above: this one is fixable by supplying a credential, and a client
  // should degrade rather than abandon the endpoint. Same envelope, different code.
  it('POST /v1/assets/media answers the documented 503 when unconfigured', async () => {
    const res = await post({}, '/v1/assets/media', {
      fingerprints: ['asset1cpfcfxay6s73xez8srvhf0pydtd9yqs8hyfawv'],
    })

    expect(res.statusCode).toBe(503)
    expect(validate('Error', res.body)).toEqual([])
    expect((res.body as { error: { code: string } }).error.code).toBe('FEATURE_UNAVAILABLE')
  })

  // The error envelope is the same everywhere, and the spec says so on every endpoint. If it were
  // not, a client would need a special case per route, which is precisely what a contract is for.
  it('an error, from any endpoint, matches the one documented envelope', async () => {
    const res = await get(
      {
        getTip: async () => {
          throw new Error('upstream fell over')
        },
      },
      '/v1/chain/tip',
    )

    expect(res.statusCode).toBe(500)
    expect(validate('Error', res.body)).toEqual([])
  })

  it('a bad request matches it too', async () => {
    const res = await post({}, '/v1/pools/info', { poolIds: ['not-a-pool-id'] })

    expect(res.statusCode).toBe(400)
    expect(validate('Error', res.body)).toEqual([])
  })
})

describe('GET /v1/openapi.json', () => {
  it('serves the contract from the instance that implements it', async () => {
    const app = await buildServer({ provider: fakeProvider() })

    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' })

    expect(res.statusCode).toBe(200)
    expect(res.json().openapi).toBe('3.1.0')
    expect(Object.keys(res.json().paths).length).toBeGreaterThan(10)
    await app.close()
  })
})
