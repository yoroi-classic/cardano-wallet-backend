import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { MalformedUpstreamError } from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'

const POLICY_REGISTRY = 'a'.repeat(56)
const POLICY_CIP25 = 'b'.repeat(56)
const POLICY_CIP68 = 'c'.repeat(56)
const POLICY_MISSING = 'd'.repeat(56)

const SUBJECT_REGISTRY = `${POLICY_REGISTRY}6e7574636f696e` // asset name "nutcoin"
const SUBJECT_CIP25 = `${POLICY_CIP25}4e4654` // asset name "NFT"
const SUBJECT_CIP68 = `${POLICY_CIP68}0014df10746f6b656e` // (000)cip67-label + "token", binary prefix
const SUBJECT_MISSING = `${POLICY_MISSING}6e6f7065`

type Reply = { status: number } | Record<string, unknown>

// Route `/assets/{subject}` reads by the subject the path ends with. A reply carrying a numeric
// `status` is served as that HTTP status (a 404 has no asset), anything else as a 200 JSON body.
function providerFor(
  bySubject: Record<string, Reply>,
): ReturnType<typeof createBlockfrostProvider> {
  const fetchImpl: FetchLike = async (url) => {
    const subject = Object.keys(bySubject).find((s) =>
      new URL(url).pathname.endsWith(`/assets/${s}`),
    )
    if (subject === undefined) throw new Error(`test has no answer for ${url}`)
    const reply = bySubject[subject] as Reply
    if ('status' in reply && typeof reply.status === 'number') {
      return {
        ok: reply.status < 400,
        status: reply.status,
        json: async () => ({}),
        text: async () => '',
      }
    }
    return { ok: true, status: 200, json: async () => reply, text: async () => '' }
  }
  return createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })
}

const REGISTRY_ROW = {
  asset: SUBJECT_REGISTRY,
  policy_id: POLICY_REGISTRY,
  asset_name: '6e7574636f696e',
  fingerprint: 'asset1pkpwyknlvul7az0xx8czhl60pyel45rpje4z8w',
  quantity: '12000',
  initial_mint_tx_hash: 'aa'.repeat(32),
  mint_or_burn_count: 1,
  onchain_metadata: null,
  onchain_metadata_standard: null,
  metadata: {
    name: 'nutcoin',
    description: 'The Nut Coin',
    ticker: 'nutc',
    url: 'https://www.stakenuts.com/',
    // A base64 logo blob the driver must not surface; it renders images elsewhere.
    logo: 'iVBORw0KGgoAAAANSUhEUgAAADA',
    decimals: 6,
  },
}

const CIP25_ROW = {
  asset: SUBJECT_CIP25,
  policy_id: POLICY_CIP25,
  asset_name: '4e4654',
  fingerprint: 'asset1cip25nftxxxxxxxxxxxxxxxxxxxxxxx',
  quantity: '1',
  initial_mint_tx_hash: 'bb'.repeat(32),
  mint_or_burn_count: 1,
  onchain_metadata: {
    name: 'Cool NFT',
    image: 'ipfs://Qmimage',
    description: 'a cool one',
    background: 'Seafoam Green',
    accessories: 'Spider',
    files: [{ src: 'ipfs://Qmfile', mediaType: 'image/png' }],
    Project: 'Clay Nation',
  },
  onchain_metadata_standard: 'CIP25v1',
  metadata: null,
}

const CIP68_ROW = {
  asset: SUBJECT_CIP68,
  policy_id: POLICY_CIP68,
  asset_name: '0014df10746f6b656e',
  fingerprint: 'asset1cip68ftxxxxxxxxxxxxxxxxxxxxxxxx',
  quantity: '1000000',
  initial_mint_tx_hash: 'cc'.repeat(32),
  mint_or_burn_count: 1,
  onchain_metadata: {
    name: 'MyToken',
    ticker: 'MTK',
    description: 'a fungible token',
    url: 'https://mytoken.io',
    image: 'ipfs://Qmlogo',
    decimals: 4,
  },
  onchain_metadata_standard: 'CIP68v1',
  metadata: null,
}

describe('blockfrost assets — happy path', () => {
  it('returns [] without calling upstream for an empty input', async () => {
    let called = false
    const fetchImpl: FetchLike = async () => {
      called = true
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.getTokenMetadata([])).resolves.toEqual([])
    expect(called).toBe(false)
  })

  it('maps the off-chain registry projection to source "registry", dropping the logo blob', async () => {
    const provider = providerFor({ [SUBJECT_REGISTRY]: REGISTRY_ROW })

    const [token] = await provider.getTokenMetadata([SUBJECT_REGISTRY])

    expect(token).toEqual({
      subject: SUBJECT_REGISTRY,
      policyId: POLICY_REGISTRY,
      assetName: '6e7574636f696e',
      assetNameAscii: 'nutcoin',
      fingerprint: 'asset1pkpwyknlvul7az0xx8czhl60pyel45rpje4z8w',
      supply: '12000',
      source: 'registry',
      name: 'nutcoin',
      ticker: 'nutc',
      description: 'The Nut Coin',
      decimals: 6,
      url: 'https://www.stakenuts.com/',
    })
  })

  it('maps decoded CIP-25 mint metadata to source "cip25", subtracting reserved names as traits', async () => {
    const provider = providerFor({ [SUBJECT_CIP25]: CIP25_ROW })

    const [token] = await provider.getTokenMetadata([SUBJECT_CIP25])

    expect(token).toEqual({
      subject: SUBJECT_CIP25,
      policyId: POLICY_CIP25,
      assetName: '4e4654',
      assetNameAscii: 'NFT',
      fingerprint: 'asset1cip25nftxxxxxxxxxxxxxxxxxxxxxxx',
      supply: '1',
      source: 'cip25',
      name: 'Cool NFT',
      description: 'a cool one',
      image: 'ipfs://Qmimage',
      // background and accessories are traits; name/image/description/files/Project are not.
      traits: { background: 'Seafoam Green', accessories: 'Spider' },
    })
  })

  it('maps a decoded CIP-68 datum to source "cip68" with ticker/url/decimals, ascii name absent', async () => {
    const provider = providerFor({ [SUBJECT_CIP68]: CIP68_ROW })

    const [token] = await provider.getTokenMetadata([SUBJECT_CIP68])

    expect(token).toEqual({
      subject: SUBJECT_CIP68,
      policyId: POLICY_CIP68,
      assetName: '0014df10746f6b656e',
      // The CIP-67 label prefix begins with a 0x00 byte, so the name is not printable ASCII.
      fingerprint: 'asset1cip68ftxxxxxxxxxxxxxxxxxxxxxxxx',
      supply: '1000000',
      source: 'cip68',
      name: 'MyToken',
      ticker: 'MTK',
      description: 'a fungible token',
      decimals: 4,
      url: 'https://mytoken.io',
      image: 'ipfs://Qmlogo',
    })
    expect(token?.assetNameAscii).toBeUndefined()
  })

  it('prefers the registry over on-chain metadata when both are present', async () => {
    const both = {
      ...CIP25_ROW,
      asset: SUBJECT_REGISTRY,
      policy_id: POLICY_REGISTRY,
      metadata: REGISTRY_ROW.metadata,
    }
    const provider = providerFor({ [SUBJECT_REGISTRY]: both })

    const [token] = await provider.getTokenMetadata([SUBJECT_REGISTRY])

    expect(token?.source).toBe('registry')
    expect(token?.name).toBe('nutcoin')
  })

  it('resolves source "none" when on-chain metadata carries no recognizable fields', async () => {
    const empty = {
      ...CIP25_ROW,
      onchain_metadata: { files: [{ src: 'ipfs://x' }], mediaType: 'image/png' },
    }
    const provider = providerFor({ [SUBJECT_CIP25]: empty })

    const [token] = await provider.getTokenMetadata([SUBJECT_CIP25])

    expect(token?.source).toBe('none')
    expect(token?.name).toBeUndefined()
  })

  it('joins chunked CIP-25 name and description rather than discarding them', async () => {
    // CIP-25 splits any value over 64 bytes across an array of strings; Blockfrost passes the
    // decoded metadata through as-is. A driver that only read plain strings would drop the name
    // (resolving the asset as `none`) and lose the description.
    const chunked = {
      ...CIP25_ROW,
      onchain_metadata: {
        name: ['A very long collectible name that the minter ', 'had to split across two chunks'],
        description: [
          'This description is also longer than sixty-four ',
          'bytes, so it is chunked',
        ],
        image: ['ipfs://', 'Qmchunkedimage'],
      },
    }
    const provider = providerFor({ [SUBJECT_CIP25]: chunked })

    const [token] = await provider.getTokenMetadata([SUBJECT_CIP25])

    expect(token?.source).toBe('cip25')
    expect(token?.name).toBe(
      'A very long collectible name that the minter had to split across two chunks',
    )
    expect(token?.description).toBe(
      'This description is also longer than sixty-four bytes, so it is chunked',
    )
    expect(token?.image).toBe('ipfs://Qmchunkedimage')
  })

  it('omits an unknown subject (404) and preserves caller order for the rest', async () => {
    const provider = providerFor({
      [SUBJECT_REGISTRY]: REGISTRY_ROW,
      [SUBJECT_MISSING]: { status: 404 },
      [SUBJECT_CIP25]: CIP25_ROW,
    })

    const tokens = await provider.getTokenMetadata([
      SUBJECT_REGISTRY,
      SUBJECT_MISSING,
      SUBJECT_CIP25,
    ])

    expect(tokens.map((t) => t.subject)).toEqual([SUBJECT_REGISTRY, SUBJECT_CIP25])
  })

  it('lower-cases subjects so the resource path matches Blockfrost regardless of caller casing', async () => {
    const provider = providerFor({ [SUBJECT_REGISTRY]: REGISTRY_ROW })

    const [token] = await provider.getTokenMetadata([SUBJECT_REGISTRY.toUpperCase()])

    expect(token?.subject).toBe(SUBJECT_REGISTRY)
  })
})

describe('blockfrost assets — unhappy path', () => {
  it('throws MalformedUpstreamError when a required asset field is missing', async () => {
    const broken: Record<string, unknown> = { ...REGISTRY_ROW }
    delete broken.fingerprint
    const provider = providerFor({ [SUBJECT_REGISTRY]: broken })

    await expect(provider.getTokenMetadata([SUBJECT_REGISTRY])).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })

  it('rejects a non-integer registry decimals rather than handing the wallet a bad precision', async () => {
    const bad = { ...REGISTRY_ROW, metadata: { ...REGISTRY_ROW.metadata, decimals: 2.5 } }
    const provider = providerFor({ [SUBJECT_REGISTRY]: bad })

    await expect(provider.getTokenMetadata([SUBJECT_REGISTRY])).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })
})
