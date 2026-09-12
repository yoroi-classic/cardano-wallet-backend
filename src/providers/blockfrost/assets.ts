import { z } from 'zod'
import { POLICY_ID_HEX_LEN } from '../../domain/constants.js'
import type { TokenMetadata } from '../../domain/types/assets.js'
import type { AssetCapability } from '../capabilities/assets.js'
import type { BlockfrostClient } from './client.js'
import { mapWithConcurrency } from './concurrency.js'
import { numeric } from './schema.js'

// How many `/assets/{asset}` lookups run at once. Blockfrost has no batch form of asset metadata,
// so a wallet asking about the tokens it holds turns into one request per subject; a modest
// ceiling overlaps the round trips without opening hundreds of authenticated connections at once,
// exactly as filterUsedAddresses does. Every request is also paced by the client's shared rate
// limiter, so this bounds fan-out, not the request rate.
const ASSET_LOOKUP_CONCURRENCY = 10

// The CIP-26 off-chain registry projection Blockfrost fetches from the token registry. `logo` is a
// base64 image blob and is deliberately not read: the wallet renders images from a separate media
// surface, so pulling the bytes in only to drop them is waste. Blockfrost has no field projection,
// so the bytes still arrive on the wire (unlike the Koios driver, which projects them away in the
// query); zod strips the unread key here. `decimals` is a count of places, so a non-negative
// integer, held to that shape the same way the Koios driver does.
const registryMetadata = z.object({
  name: z.string().nullish(),
  description: z.string().nullish(),
  ticker: z.string().nullish(),
  url: z.string().nullish(),
  decimals: z.number().int().nonnegative().nullish(),
})

/** `asset` (Blockfrost OpenAPI spec, `/assets/{asset}`), projected to the fields we map. */
const assetRow = z.object({
  policy_id: z.string(),
  asset_name: z.string().nullish(),
  fingerprint: z.string(),
  // Current on-chain quantity (mints minus burns); the domain's `supply`.
  quantity: numeric,
  // Blockfrost decodes CIP-25 mint metadata and CIP-68 reference-token datums server-side into
  // this one object, and names which standard it validated under below. Attacker-influenced
  // on-chain data, so it is walked defensively even though Blockfrost has already parsed it.
  onchain_metadata: z.record(z.string(), z.unknown()).nullish(),
  // 'CIP25v1' | 'CIP25v2' | 'CIP68v1' | 'CIP68v2' | 'CIP68v3', or null when nothing validated.
  onchain_metadata_standard: z.string().nullish(),
  metadata: registryMetadata.nullish(),
})

type OnchainMetadata = Record<string, unknown>

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

// CIP-25 allows a long string to be split across an array of chunks; join them. Anything that is
// not a string or array of strings is ignored rather than trusted. Blockfrost usually returns the
// decoded metadata verbatim, so a chunked image can still arrive as an array here.
function cip25String(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value.length > 0 ? value.join('') : undefined
  }
  return undefined
}

// A count of decimal places from minter-controlled metadata: a non-negative safe integer or
// nothing. A wrong precision misrenders every balance for the token, so anything else is dropped
// rather than passed through, the same bar the Koios driver holds CIP-68 decimals to.
function toDecimals(value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * The field names CIP-25 reserves; everything else in an asset's metadata map is a trait.
 *
 * Identical to the Koios driver's set and for the same reason: CIP-25 names these fields and says
 * nothing about the rest, so the traits are whatever the minter put there and are found by
 * subtracting the reserved names rather than matching an allowlist that would drop the next
 * collection's attributes. `files`/`mediaType` are structural, and `Project` is a collection-level
 * label rather than a per-asset property.
 */
const CIP25_RESERVED = new Set([
  'name',
  'image',
  'description',
  'mediaType',
  'files',
  'Project',
  'project',
])

// Traits: every metadata field the spec did not reserve, flattened to a string label. A nested
// object or list of files is structure, not a trait, so it is skipped rather than stringified to
// `[object Object]` on someone's NFT card.
function extractTraits(entry: OnchainMetadata): Record<string, string> | undefined {
  const traits: Record<string, string> = {}
  for (const [key, raw] of Object.entries(entry)) {
    if (CIP25_RESERVED.has(key)) continue
    const value = cip25String(raw)
    if (value === undefined || value.length === 0) continue
    traits[key] = value
  }
  return Object.keys(traits).length > 0 ? traits : undefined
}

/**
 * The asset name decoded as printable ASCII, or undefined when it is not.
 *
 * Blockfrost, unlike Koios, does not return an `asset_name_ascii` field, so it is derived here to
 * keep the output shape at parity. Only clean printable ASCII (0x20 to 0x7e) qualifies: a name that
 * is binary, or valid UTF-8 but not ASCII, is reported absent rather than shown as mojibake, which
 * is the same conservative call the Koios projection makes.
 */
function asciiAssetName(assetNameHex: string): string | undefined {
  if (assetNameHex.length === 0 || assetNameHex.length % 2 !== 0) return undefined
  if (!/^[0-9a-fA-F]+$/.test(assetNameHex)) return undefined
  let out = ''
  for (const byte of Buffer.from(assetNameHex, 'hex')) {
    if (byte < 0x20 || byte > 0x7e) return undefined
    out += String.fromCharCode(byte)
  }
  return out.length > 0 ? out : undefined
}

function mapTokenMetadata(subject: string, row: z.infer<typeof assetRow>): TokenMetadata {
  // Derived from the subject the caller asked about rather than the echoed row, so an empty asset
  // name (a real, common case Blockfrost answers with `asset_name: null`) stays '' rather than
  // becoming null, and policy id / asset name always split at the protocol-fixed boundary.
  const policyId = subject.slice(0, POLICY_ID_HEX_LEN)
  const assetName = subject.slice(POLICY_ID_HEX_LEN)
  const base = {
    subject,
    policyId,
    assetName,
    assetNameAscii: asciiAssetName(assetName),
    fingerprint: row.fingerprint,
    supply: String(row.quantity),
  }

  // Registry is preferred, then Blockfrost's decoded on-chain metadata, then nothing, matching the
  // Koios driver's registry -> CIP-25 -> CIP-68 -> none order. Every registry field counts as
  // "has a registry entry", not just the display ones, so a token registered with only `decimals`
  // is still `registry` rather than being mislabelled.
  const m = row.metadata
  const hasRegistry =
    m != null &&
    (m.name != null ||
      m.ticker != null ||
      m.description != null ||
      m.url != null ||
      m.decimals != null)
  if (m != null && hasRegistry) {
    return {
      ...base,
      source: 'registry',
      name: m.name ?? undefined,
      ticker: m.ticker ?? undefined,
      description: m.description ?? undefined,
      decimals: m.decimals ?? undefined,
      url: m.url ?? undefined,
    }
  }

  // Blockfrost resolves both CIP-25 mint metadata and CIP-68 reference-token datums into
  // `onchain_metadata` and says which via `onchain_metadata_standard`. That server-side decode is
  // what makes CIP-68 reachable at all here: Blockfrost exposes no raw datum for us to walk the way
  // the Koios driver walks Koios's `cip68_metadata`, so a datum Blockfrost cannot decode comes back
  // null and falls through to `source: 'none'`, the same terminal state Koios reaches when its own
  // extraction finds nothing. The trade is that Blockfrost's decoder, not ours, handles the nested
  // v4 unwrap, chunked bytestrings, and label fallbacks.
  const onchain = row.onchain_metadata
  if (onchain != null) {
    const standard = row.onchain_metadata_standard
    const isCip68 = typeof standard === 'string' && standard.toLowerCase().startsWith('cip68')
    // name and description, like image, may arrive chunked: CIP-25 splits any value over 64 bytes
    // across an array of strings, and Blockfrost passes the decoded metadata through verbatim.
    // Join the chunks rather than discarding a split field, which would otherwise resolve the asset
    // as `none` or strip its display text.
    const name = cip25String(onchain.name)
    const description = cip25String(onchain.description)
    const image = cip25String(onchain.image) ?? cip25String(onchain.logo)

    if (isCip68) {
      const ticker = asString(onchain.ticker)
      // A url can exceed 64 bytes and be chunked the same way name/image can.
      const url = cip25String(onchain.url)
      const decimals = toDecimals(onchain.decimals)
      if (name || ticker || description || url || image || decimals != null) {
        return { ...base, source: 'cip68', name, ticker, description, decimals, url, image }
      }
    } else {
      const traits = extractTraits(onchain)
      if (name || description || image || traits) {
        return {
          ...base,
          source: 'cip25',
          name,
          description,
          image,
          // Absent, never `{}`: a token with no traits has none rather than zero of them.
          ...(traits === undefined ? {} : { traits }),
        }
      }
    }
  }

  return { ...base, source: 'none' }
}

export function createAssetMethods(client: BlockfrostClient): AssetCapability {
  return {
    async getTokenMetadata(subjects: string[]): Promise<TokenMetadata[]> {
      if (subjects.length === 0) return []
      // Blockfrost keys assets by lowercase hex; normalize so the path matches its resource.
      const normalized = subjects.map((s) => s.toLowerCase())

      // One paced, bounded-concurrency lookup per subject. A subject with no asset answers 404,
      // which `getOrUndefined` turns into `undefined` (absent, not an error), so unknown subjects
      // drop out below and the result is never longer than the input, in the caller's order.
      const mapped = await mapWithConcurrency(
        normalized,
        ASSET_LOOKUP_CONCURRENCY,
        async (subject) => {
          const row = await client.getOrUndefined(
            assetRow,
            `/assets/${encodeURIComponent(subject)}`,
          )
          return row === undefined ? undefined : mapTokenMetadata(subject, row)
        },
      )
      return mapped.filter((meta): meta is TokenMetadata => meta !== undefined)
    },
  }
}
