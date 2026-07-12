import { describe, expect, it } from 'vitest'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'
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
      source: 'registry',
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
      source: 'none',
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

  it('falls back to CIP-25 mint metadata for an NFT (image + name), keyed by the v1 text name', async () => {
    const POLICY = 'c'.repeat(56)
    const NAME_HEX = '4d794e4654' // "MyNFT"
    const subject = POLICY + NAME_HEX
    const known = {
      [subject]: {
        policy_id: POLICY,
        asset_name: NAME_HEX,
        fingerprint: 'asset1nft',
        total_supply: '1',
        name: null,
        ticker: null,
        description: null,
        url: null,
        decimals: null,
        minting_tx_metadata: {
          // Keyed by the asset name as text, which is CIP-25 version 1 and is what every one
          // of the 131 live mainnet CIP-25 assets surveyed actually does.
          '721': {
            [POLICY]: {
              MyNFT: {
                name: 'My NFT',
                image: 'ipfs://QmImageHash',
                description: 'a picture',
                mediaType: 'image/png',
              },
            },
          },
        },
      },
    }
    const { fetchImpl } = assetFetch(known)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([subject])

    expect(token?.source).toBe('cip25')
    expect(token?.name).toBe('My NFT')
    expect(token?.image).toBe('ipfs://QmImageHash')
    expect(token?.description).toBe('a picture')
  })

  it('reads a CIP-25 entry keyed by the decoded asset name and joins a chunked image', async () => {
    const POLICY = 'd'.repeat(56)
    const NAME_HEX = '4d794e4654'
    const subject = POLICY + NAME_HEX
    const known = {
      [subject]: {
        policy_id: POLICY,
        asset_name: NAME_HEX,
        asset_name_ascii: 'MyNFT',
        fingerprint: 'asset1nft2',
        total_supply: '1',
        name: null,
        ticker: null,
        description: null,
        url: null,
        decimals: null,
        minting_tx_metadata: {
          '721': {
            [POLICY]: {
              // Keyed by the human-readable name, and the image split into CIP-25 chunks.
              MyNFT: { name: 'My NFT', image: ['ipfs://Qm', 'ImageHash'] },
            },
          },
        },
      },
    }
    const { fetchImpl } = assetFetch(known)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([subject])

    expect(token?.source).toBe('cip25')
    expect(token?.image).toBe('ipfs://QmImageHash')
  })

  it('prefers the registry over CIP-25 when both are present', async () => {
    const POLICY = 'e'.repeat(56)
    const NAME_HEX = '41'
    const subject = POLICY + NAME_HEX
    const known = {
      [subject]: {
        policy_id: POLICY,
        asset_name: NAME_HEX,
        fingerprint: 'asset1both',
        total_supply: '1',
        name: 'Registry Name',
        ticker: 'REG',
        description: null,
        url: null,
        decimals: null,
        minting_tx_metadata: {
          '721': { [POLICY]: { [NAME_HEX]: { name: 'Onchain Name', image: 'ipfs://x' } } },
        },
      },
    }
    const { fetchImpl } = assetFetch(known)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([subject])

    expect(token?.source).toBe('registry')
    expect(token?.name).toBe('Registry Name')
    expect(token?.image).toBeUndefined()
  })

  // A registry entry carrying only decimals (or only a url) is unusual but legitimate. If
  // the registry check tested just the display fields, this token would fall through to the
  // CIP-25 branch, be labelled the wrong source, and lose its decimals, which is the value
  // the wallet needs to render a balance correctly.
  it.each([
    ['decimals', { decimals: 6 }],
    ['url', { url: 'https://token.example' }],
  ])('treats a registry entry with only %s as a registry token', async (_field, registry) => {
    const POLICY = 'd'.repeat(56)
    const NAME_HEX = '42'
    const subject = POLICY + NAME_HEX
    const known = {
      [subject]: {
        policy_id: POLICY,
        asset_name: NAME_HEX,
        fingerprint: 'asset1sparse',
        total_supply: '1000',
        name: null,
        ticker: null,
        description: null,
        url: null,
        decimals: null,
        ...registry,
      },
    }
    const { fetchImpl } = assetFetch(known)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([subject])

    expect(token?.source).toBe('registry')
    expect({ decimals: token?.decimals, url: token?.url }).toMatchObject(registry)
  })

  it('falls back to a CIP-68 datum, decoding hex-keyed name/ticker/decimals/url/image', async () => {
    const POLICY = 'f'.repeat(56)
    const NAME_HEX = '000de14054455354'
    const subject = POLICY + NAME_HEX
    const known = {
      [subject]: {
        policy_id: POLICY,
        asset_name: NAME_HEX,
        fingerprint: 'asset1cip68',
        total_supply: '1000',
        name: null,
        ticker: null,
        description: null,
        url: null,
        decimals: null,
        minting_tx_metadata: null,
        // Shaped after a live Koios cip68_metadata (label 100) PlutusData datum.
        cip68_metadata: {
          '100': {
            constructor: 0,
            fields: [
              {
                map: [
                  { k: { bytes: '646563696d616c73' }, v: { int: 6 } },
                  {
                    k: { bytes: '6465736372697074696f6e' },
                    v: { bytes: '54455354' },
                  },
                  { k: { bytes: '6c6f676f' }, v: { bytes: '697066733a2f2f516d61' } },
                  { k: { bytes: '6e616d65' }, v: { bytes: '54455354' } },
                  { k: { bytes: '7469636b6572' }, v: { bytes: '5445535454455354' } },
                  {
                    k: { bytes: '75726c' },
                    v: { bytes: '68747470733a2f2f746573742e696f' },
                  },
                ],
              },
            ],
          },
        },
      },
    }
    const { fetchImpl } = assetFetch(known)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([subject])

    expect(token?.source).toBe('cip68')
    expect(token?.name).toBe('TEST')
    expect(token?.ticker).toBe('TESTTEST')
    expect(token?.description).toBe('TEST')
    expect(token?.decimals).toBe(6)
    expect(token?.url).toBe('https://test.io')
    expect(token?.image).toBe('ipfs://Qma')
  })

  // A CIP-68 datum is written by the minter, so its bytes are attacker controlled. A lenient
  // UTF-8 decode turns arbitrary bytes into U+FFFD replacement characters and would hand the
  // wallet a "name" of garbage to render. The field has to be dropped instead.
  it('drops a CIP-68 string whose bytes are not valid utf-8', async () => {
    const POLICY = '2'.repeat(56)
    const NAME_HEX = '63'
    const subject = POLICY + NAME_HEX
    const known = {
      [subject]: {
        policy_id: POLICY,
        asset_name: NAME_HEX,
        fingerprint: 'asset1bad',
        total_supply: '1',
        name: null,
        ticker: null,
        description: null,
        url: null,
        decimals: null,
        minting_tx_metadata: null,
        cip68_metadata: {
          '100': {
            constructor: 0,
            fields: [
              {
                map: [
                  // 'name' -> 0xff 0xfe, which is not a valid UTF-8 sequence.
                  { k: { bytes: '6e616d65' }, v: { bytes: 'fffe' } },
                  // 'ticker' -> valid, so the datum is still recognized as CIP-68.
                  { k: { bytes: '7469636b6572' }, v: { bytes: '4f4b' } },
                ],
              },
            ],
          },
        },
      },
    }
    const { fetchImpl } = assetFetch(known)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([subject])

    expect(token?.source).toBe('cip68')
    expect(token?.ticker).toBe('OK')
    expect(token?.name).toBeUndefined()
    expect(token?.name ?? '').not.toContain('�')
  })

  // A bad precision misrenders every balance for the token, so a datum decimals that is
  // negative, fractional, or past the safe integer range is dropped rather than trusted.
  it.each([
    ['negative', { int: -1 }],
    ['fractional', { int: 2.5 }],
    ['past the safe range', { int: '9007199254740993' }],
  ])('drops a CIP-68 decimals that is %s', async (_case, value) => {
    const POLICY = '3'.repeat(56)
    const NAME_HEX = '64'
    const subject = POLICY + NAME_HEX
    const known = {
      [subject]: {
        policy_id: POLICY,
        asset_name: NAME_HEX,
        fingerprint: 'asset1dec',
        total_supply: '1',
        name: null,
        ticker: null,
        description: null,
        url: null,
        decimals: null,
        minting_tx_metadata: null,
        cip68_metadata: {
          '100': {
            constructor: 0,
            fields: [
              {
                map: [
                  { k: { bytes: '6e616d65' }, v: { bytes: '4f4b' } },
                  { k: { bytes: '646563696d616c73' }, v: value },
                ],
              },
            ],
          },
        },
      },
    }
    const { fetchImpl } = assetFetch(known)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([subject])

    expect(token?.source).toBe('cip68')
    expect(token?.name).toBe('OK')
    expect(token?.decimals).toBeUndefined()
  })

  it('prefers the registry and CIP-25 over a CIP-68 datum', async () => {
    const POLICY = '1'.repeat(56)
    const NAME_HEX = '61'
    const subject = POLICY + NAME_HEX
    const cip68 = {
      '100': {
        constructor: 0,
        fields: [{ map: [{ k: { bytes: '6e616d65' }, v: { bytes: '3638' } }] }],
      },
    }
    const known = {
      [subject]: {
        policy_id: POLICY,
        asset_name: NAME_HEX,
        fingerprint: 'asset1pref',
        total_supply: '1',
        name: null,
        ticker: null,
        description: null,
        url: null,
        decimals: null,
        minting_tx_metadata: {
          // v1: keyed by the asset name as text ('61' is "a"), which is what live mints do.
          '721': { [POLICY]: { a: { name: 'CIP25 Name' } } },
        },
        cip68_metadata: cip68,
      },
    }
    const { fetchImpl } = assetFetch(known)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([subject])

    // CIP-25 is present, so it wins over the CIP-68 datum.
    expect(token?.source).toBe('cip25')
    expect(token?.name).toBe('CIP25 Name')
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

describe('koios getTokenMetadata — CIP-68 chunked byte strings', () => {
  const POLICY = 'e'.repeat(56)
  const NAME_HEX = '000de140434855'
  const SUBJECT = POLICY + NAME_HEX

  function cip68Row(map: unknown[]) {
    return {
      [SUBJECT]: {
        policy_id: POLICY,
        asset_name: NAME_HEX,
        fingerprint: 'asset1chunked',
        total_supply: '1',
        name: null,
        ticker: null,
        description: null,
        url: null,
        decimals: null,
        minting_tx_metadata: null,
        cip68_metadata: { '100': { constructor: 0, fields: [{ map }] } },
      },
    }
  }

  it('joins a chunked image URI, which a bytestring over 64 bytes must be', async () => {
    // PlutusData caps a bytestring at 64 bytes, so CIP-68 requires a longer value to be
    // split across a list. A long image URI is the usual case; reading only the single
    // form drops exactly those images.
    const uri =
      'https://example.com/very/long/asset/image/path/that/exceeds/the/sixty-four-byte/plutus/bytestring/limit.png'
    const known = cip68Row([
      { k: { bytes: '6e616d65' }, v: { bytes: '434855' } },
      {
        k: { bytes: '696d616765' },
        v: {
          list: [
            {
              bytes:
                '68747470733a2f2f6578616d706c652e636f6d2f766572792f6c6f6e672f61737365742f696d6167652f706174682f746861742f657863656564732f7468652f',
            },
            {
              bytes:
                '73697874792d666f75722d627974652f706c757475732f62797465737472696e672f6c696d69742e706e67',
            },
          ],
        },
      },
    ])
    const { fetchImpl } = assetFetch(known)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([SUBJECT])

    expect(token?.source).toBe('cip68')
    expect(token?.image).toBe(uri)
  })

  it('joins chunks as bytes, so a multi-byte character split across a boundary survives', async () => {
    // The chunks below cut the middle of a 3-byte UTF-8 character (e2 98 95). Decoding each
    // chunk on its own and concatenating the results would fail on both halves (the decoder
    // is fatal) and lose the field entirely. Joining the bytes first is what makes it work.
    const known = cip68Row([
      {
        k: { bytes: '6e616d65' },
        v: { list: [{ bytes: '4361666520e2' }, { bytes: '989520546f6b656e' }] },
      },
    ])
    const { fetchImpl } = assetFetch(known)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([SUBJECT])

    expect(token?.source).toBe('cip68')
    expect(token?.name).toBe('Cafe ☕ Token')
  })

  it('drops a chunk list holding a non-bytestring rather than trusting it', async () => {
    const known = cip68Row([
      { k: { bytes: '6e616d65' }, v: { list: [{ bytes: '4361666520e2' }, { int: 7 }] } },
      { k: { bytes: '7469636b6572' }, v: { bytes: '434855' } },
    ])
    const { fetchImpl } = assetFetch(known)
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([SUBJECT])

    expect(token?.name).toBeUndefined()
    expect(token?.ticker).toBe('CHU')
  })
})

describe('koios getTokenMetadata — CIP-68 version 4 nested map', () => {
  // CIP-68 declares `version = 1 / 2 / 3 / 4`. Versions 1-3 put the metadata map directly in
  // fields[0]; version 4 wraps it CIP-25 style under a "721" key:
  //
  //   { "721": { <policy_id>: { <asset_name>: <metadata> } } }
  //
  // A v4 datum walked as if it were v1 finds none of its fields and resolves as
  // `source: 'none'`, silently losing the asset's name and image.
  const POLICY = 'a'.repeat(56)
  const LABEL = '000de140' // CIP-67 label (222, NFT). The nested map keys without it.
  const BARE_NAME = '4d794e4654' // "MyNFT"
  const NAME_HEX = LABEL + BARE_NAME
  const SUBJECT = POLICY + NAME_HEX

  const metadata = {
    map: [
      { k: { bytes: '6e616d65' }, v: { bytes: '41207634204e4654' } }, // name: "A v4 NFT"
      { k: { bytes: '696d616765' }, v: { bytes: '697066733a2f2f7634696d616765' } }, // ipfs://v4image
    ],
  }

  function v4Row(assetKeyHex: string) {
    return {
      [SUBJECT]: {
        policy_id: POLICY,
        asset_name: NAME_HEX,
        fingerprint: 'asset1v4',
        total_supply: '1',
        name: null,
        ticker: null,
        description: null,
        url: null,
        decimals: null,
        minting_tx_metadata: null,
        cip68_metadata: {
          '222': {
            constructor: 0,
            fields: [
              {
                map: [
                  {
                    k: { bytes: '373231' }, // "721"
                    v: {
                      map: [
                        {
                          k: { bytes: POLICY },
                          v: { map: [{ k: { bytes: assetKeyHex }, v: metadata }] },
                        },
                      ],
                    },
                  },
                ],
              },
              { int: 4 },
            ],
          },
        },
      },
    }
  }

  it('resolves a version-4 datum that keys the asset without its CIP-67 label prefix', async () => {
    const { fetchImpl } = assetFetch(v4Row(BARE_NAME))
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([SUBJECT])

    expect(token?.source).toBe('cip68')
    expect(token?.name).toBe('A v4 NFT')
    expect(token?.image).toBe('ipfs://v4image')
  })

  it('also reads a version-4 datum whose minter kept the label prefix on the key', async () => {
    const { fetchImpl } = assetFetch(v4Row(NAME_HEX))
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([SUBJECT])

    expect(token?.source).toBe('cip68')
    expect(token?.name).toBe('A v4 NFT')
  })

  it('does not mistake another asset’s entry in the nested map for this one', async () => {
    // The nested form can carry several assets. Reading the wrong one would put a different
    // NFT's name and image on this token.
    const { fetchImpl } = assetFetch(v4Row('deadbeef'))
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([SUBJECT])

    expect(token?.source).toBe('none')
    expect(token?.name).toBeUndefined()
  })
})

describe('koios getTokenMetadata — CIP-25 keys the asset by version', () => {
  // Per CIP-25: version 1 keys the metadata map by the asset name as UTF-8 *text*, version 2
  // by its *raw bytes*, and the version defaults to 1 when absent.
  const POLICY = 'b'.repeat(56)
  const ABC_HEX = '616263' // "abc"
  const LITERAL_HEX = '363136323633' // the six characters "616263"

  function row(assetNameHex: string, minting: unknown) {
    return {
      [POLICY + assetNameHex]: {
        policy_id: POLICY,
        asset_name: assetNameHex,
        asset_name_ascii: Buffer.from(assetNameHex, 'hex').toString('utf8'),
        fingerprint: 'asset1cip25',
        total_supply: '1',
        name: null,
        ticker: null,
        description: null,
        url: null,
        decimals: null,
        minting_tx_metadata: minting,
        cip68_metadata: null,
      },
    }
  }

  it('does not hand a v1 asset the metadata of another asset named after its hex', async () => {
    // The collision: asset "abc" has hex 616263. A *different* asset in the same policy is
    // literally named "616263". A v1 map is keyed by text, so it holds both "abc" and
    // "616263" as keys. Looking up the hex form first would fetch the wrong one.
    const minting = {
      '721': {
        [POLICY]: {
          abc: { name: 'The real abc', image: 'ipfs://abc' },
          '616263': { name: 'A different token', image: 'ipfs://impostor' },
        },
        version: 1,
      },
    }
    const { fetchImpl } = assetFetch(row(ABC_HEX, minting))
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([POLICY + ABC_HEX])

    expect(token?.source).toBe('cip25')
    expect(token?.name).toBe('The real abc')
    expect(token?.image).toBe('ipfs://abc')
  })

  it('reads the sibling asset in that same v1 policy correctly too', async () => {
    const minting = {
      '721': {
        [POLICY]: {
          abc: { name: 'The real abc' },
          '616263': { name: 'A different token' },
        },
        version: 1,
      },
    }
    const { fetchImpl } = assetFetch(row(LITERAL_HEX, minting))
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([POLICY + LITERAL_HEX])

    expect(token?.name).toBe('A different token')
  })

  it('keys by raw bytes when the mint declares version 2', async () => {
    const minting = {
      '721': {
        [POLICY]: { [ABC_HEX]: { name: 'v2 keyed by hex' } },
        version: 2,
      },
    }
    const { fetchImpl } = assetFetch(row(ABC_HEX, minting))
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([POLICY + ABC_HEX])

    expect(token?.source).toBe('cip25')
    expect(token?.name).toBe('v2 keyed by hex')
  })

  it('resolves a v1 asset whose name is not ASCII', async () => {
    // asset_name_ascii is empty for these upstream, so the old lookup could never find them.
    // Decoding the key from the hex does.
    const CAFE_HEX = '636166c3a9' // "café"
    const minting = {
      '721': { [POLICY]: { café: { name: 'Café token' } }, version: 1 },
    }
    const { fetchImpl } = assetFetch(row(CAFE_HEX, minting))
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [token] = await provider.getTokenMetadata([POLICY + CAFE_HEX])

    expect(token?.source).toBe('cip25')
    expect(token?.name).toBe('Café token')
  })
})
