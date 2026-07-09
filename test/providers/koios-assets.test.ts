import { describe, expect, it } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios.js'
import { MalformedUpstreamError } from '../../src/domain/errors.js'

const BASE = 'https://preprod.koios.rest/api/v1'
const HOSKY_POLICY = 'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235'
const HOSKY_NAME = '484f534b59'
const HOSKY = HOSKY_POLICY + HOSKY_NAME

// A native asset with no registered off-chain metadata (empty asset name).
const BARE_POLICY = '00016c6f4d813b5e78b785e617da4dc035a206fc412e889f8f5ac79e'
const BARE = BARE_POLICY // empty asset name

interface Call {
  url: string
  body?: string | Uint8Array
}

// Shaped after live Koios /asset_info rows, keyed by subject.
const ROWS: Record<string, Record<string, unknown>> = {
  [HOSKY]: {
    policy_id: HOSKY_POLICY,
    asset_name: HOSKY_NAME,
    asset_name_ascii: 'HOSKY',
    fingerprint: 'asset17q7r59zlc3dgw0venc80pdv566q6yguw03f0d9',
    total_supply: '1000000000000001',
    // Koios flattens the registry fields out of token_registry_metadata for us; see
    // ASSET_INFO_SELECT. The base64 logo is projected away and never reaches us.
    url: 'https://hosky.io',
    name: 'HOSKY Token',
    ticker: 'HOSKY',
    decimals: 0,
    description: 'A meme token.',
  },
  [BARE]: {
    policy_id: BARE_POLICY,
    asset_name: '',
    asset_name_ascii: '',
    fingerprint: 'asset1jerjvx30k3duyjmavp20lex0sxwhyx4p07g00v',
    total_supply: '54',
    name: null,
    ticker: null,
    description: null,
    url: null,
    decimals: null,
  },
}

// Echoes back rows for whichever subjects the posted _asset_list asks for, so ordering,
// omission, and chunking all fall out naturally.
function assetFetch(known: Record<string, unknown> = ROWS): {
  fetchImpl: FetchLike
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body })
    const parsed = JSON.parse(String(init?.body)) as { _asset_list: [string, string][] }
    const rows = parsed._asset_list.map(([p, n]) => known[p + n]).filter((r) => r !== undefined)
    return { ok: true, status: 200, json: async () => rows, text: async () => '' }
  }
  return { fetchImpl, calls }
}

describe('koios getTokenMetadata', () => {
  it('maps a registry token and splits the subject into a policy/name pair', async () => {
    const { fetchImpl, calls } = assetFetch()
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([HOSKY])

    expect(token).toEqual({
      subject: HOSKY,
      policyId: HOSKY_POLICY,
      assetName: HOSKY_NAME,
      assetNameAscii: 'HOSKY',
      fingerprint: 'asset17q7r59zlc3dgw0venc80pdv566q6yguw03f0d9',
      supply: '1000000000000001',
      name: 'HOSKY Token',
      ticker: 'HOSKY',
      description: 'A meme token.',
      decimals: 0,
      url: 'https://hosky.io',
    })
    const url = decodeURIComponent(calls[0]?.url ?? '')
    expect(url).toContain(`${BASE}/asset_info?select=`)
    // The registry values are projected out of the JSON column field by field. The point of
    // doing it this way is the field we leave out: the registry object carries a base64
    // logo that dwarfs everything else on the row (73 KB of a 74 KB response for a live
    // asset), and asking for the whole object would pull it down on every batch.
    for (const field of ['name', 'ticker', 'description', 'url', 'decimals']) {
      expect(url).toContain(`${field}:token_registry_metadata-`)
    }
    expect(url).not.toContain('logo')
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      _asset_list: [[HOSKY_POLICY, HOSKY_NAME]],
    })
  })

  // An asset with an empty name is a real and common case, and Koios reports its ASCII name
  // as ''. An empty string is not a name, so it must not surface as one.
  it('reports an empty ascii asset name as absent, not as an empty string', async () => {
    const { fetchImpl } = assetFetch()
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([BARE])

    expect(token?.assetNameAscii).toBeUndefined()
  })

  // decimals is a count of places, so a negative or fractional value is upstream junk and
  // must not reach the wallet as a token precision.
  it('rejects a malformed registry decimals as malformed upstream', async () => {
    for (const bad of [-1, 2.5]) {
      const { fetchImpl } = assetFetch({
        [HOSKY]: { ...ROWS[HOSKY], decimals: bad },
      })
      const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

      await expect(provider.getTokenMetadata([HOSKY])).rejects.toBeInstanceOf(
        MalformedUpstreamError,
      )
    }
  })

  it('leaves registry fields undefined for a token without registry metadata', async () => {
    const { fetchImpl } = assetFetch()
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([BARE])

    expect(token).toEqual({
      subject: BARE,
      policyId: BARE_POLICY,
      assetName: '',
      fingerprint: 'asset1jerjvx30k3duyjmavp20lex0sxwhyx4p07g00v',
      supply: '54',
    })
    // Empty ascii name and absent registry fields are undefined (so JSON omits them),
    // not emitted as empty strings.
    expect(token?.assetNameAscii).toBeUndefined()
    expect(token?.name).toBeUndefined()
    expect(JSON.parse(JSON.stringify(token))).not.toHaveProperty('assetNameAscii')
  })

  it('returns tokens in the caller order, omitting unknown subjects, and normalizes case', async () => {
    const { fetchImpl } = assetFetch()
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const unknown = 'ff'.repeat(28) // a policy id with no on-chain asset
    const tokens = await provider.getTokenMetadata([BARE, unknown, HOSKY.toUpperCase()])

    expect(tokens.map((t) => t.subject)).toEqual([BARE, HOSKY])
  })

  it('returns [] without calling upstream for an empty batch', async () => {
    const { fetchImpl, calls } = assetFetch()
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    expect(await provider.getTokenMetadata([])).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('splits a large batch into multiple bounded upstream requests', async () => {
    // 45 distinct subjects should span three chunks of 20.
    const known: Record<string, unknown> = {}
    const subjects: string[] = []
    for (let i = 0; i < 45; i += 1) {
      const policy = i.toString(16).padStart(56, '0')
      known[policy] = {
        policy_id: policy,
        asset_name: '',
        fingerprint: `asset1x${i}`,
        total_supply: '1',
        name: null,
        ticker: null,
        description: null,
        url: null,
        decimals: null,
      }
      subjects.push(policy)
    }
    const { fetchImpl, calls } = assetFetch(known)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const tokens = await provider.getTokenMetadata(subjects)

    expect(tokens).toHaveLength(45)
    expect(tokens.map((t) => t.subject)).toEqual(subjects)
    expect(calls).toHaveLength(3)
  })
})
