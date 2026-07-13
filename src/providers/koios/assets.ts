import { z } from 'zod'
import { POLICY_ID_HEX_LEN } from '../../domain/constants.js'
import type { TokenMetadata } from '../../domain/types/assets.js'
import type { AssetCapability } from '../capabilities/assets.js'
import type { KoiosClient } from './client.js'
import { assetName, chunked, numeric, policyId } from './schema.js'

// Koios caps the asset_info request body at ~5 KB, so send subjects in bounded chunks.
const ASSET_INFO_CHUNK = 20

// Registry `decimals` is a count of decimal places, so it can only be a non-negative
// integer. Constraining it here keeps an impossible upstream value (negative, fractional)
// on the malformed path instead of handing the wallet a token precision it cannot use.
const registryDecimals = z.number().int().nonnegative().nullish()

// The CIP-26 registry fields, projected out of Koios's `token_registry_metadata` JSON and
// flattened onto the row (see ASSET_INFO_SELECT).
const assetInfoRow = z.object({
  policy_id: policyId,
  asset_name: assetName,
  asset_name_ascii: z.string().nullish(),
  fingerprint: z.string(),
  total_supply: numeric,
  name: z.string().nullish(),
  ticker: z.string().nullish(),
  description: z.string().nullish(),
  url: z.string().nullish(),
  decimals: registryDecimals,
  // Raw transaction metadata from the mint; CIP-25 (label "721") lives here. Kept opaque
  // and walked defensively because its shape is attacker-influenced on-chain data.
  minting_tx_metadata: z.unknown().nullish(),
  // Decoded CIP-68 reference-token datum (PlutusData), when the asset uses CIP-68. Also
  // opaque and walked defensively.
  cip68_metadata: z.unknown().nullish(),
})

// Ask Koios for exactly the fields we map, pulling the registry values out of the
// `token_registry_metadata` JSON column rather than taking the whole object.
//
// This is a bandwidth fix, not a cosmetic one. The registry object carries a base64 `logo`,
// and dropping it in the schema does not stop Koios from sending it: one live mainnet asset
// (SNEK) answers in 74,753 bytes, of which 73,664 is the logo. Projecting the logo away
// brings that row to 326 bytes. A wallet asking about a full batch of held tokens would
// otherwise pull megabytes of images that we parse straight into the bin. Token and NFT
// images are served from a separate media surface.
//
// `minting_tx_metadata` and `cip68_metadata` have to be named explicitly: with a projection
// in place, anything not listed here does not come back, and the CIP-25 and CIP-68
// fallbacks below read them.
const ASSET_INFO_SELECT = [
  'policy_id',
  'asset_name',
  'asset_name_ascii',
  'fingerprint',
  'total_supply',
  'minting_tx_metadata',
  'cip68_metadata',
  'name:token_registry_metadata->>name',
  'ticker:token_registry_metadata->>ticker',
  'description:token_registry_metadata->>description',
  'url:token_registry_metadata->>url',
  'decimals:token_registry_metadata->decimals',
].join(',')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function emptyToUndefined(value: string | null | undefined): string | undefined {
  return value == null || value === '' ? undefined : value
}

// A CIP-68 datum is on-chain data written by whoever minted the token, so it is attacker
// controlled. It is decoded strictly rather than leniently.
const utf8 = new TextDecoder('utf-8', { fatal: true })

// Decode a hex byte-string to UTF-8, rejecting anything that isn't clean even-length hex.
//
// The decoder is `fatal`, which is the point: the default replaces invalid byte sequences
// with U+FFFD, so a datum carrying arbitrary bytes would decode "successfully" into a
// string of replacement characters and be shown to the user as a token name. Refusing to
// decode it drops the field instead, and the asset falls through to the next source.
function hexToUtf8(hex: unknown): string | undefined {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0) return undefined
  if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined
  try {
    const text = utf8.decode(Buffer.from(hex, 'hex'))
    return text.length > 0 ? text : undefined
  } catch {
    // Not valid UTF-8. Treat the field as absent rather than surfacing mojibake.
    return undefined
  }
}

interface Cip68Fields {
  name?: string
  description?: string
  image?: string
  ticker?: string
  url?: string
  decimals?: number
}

/** The entries of a PlutusData map, or undefined when the value is not one. */
function mapEntries(value: unknown): unknown[] | undefined {
  return isRecord(value) && Array.isArray(value.map) ? value.map : undefined
}

/**
 * Unwrap a CIP-68 version-4 datum down to this asset's own metadata map, or undefined when
 * the datum is not in the nested form (versions 1 to 3), in which case the top-level map is
 * already the metadata.
 */
function unwrapNested(
  top: unknown[],
  policyIdHex: string,
  assetNameHex: string,
): unknown[] | undefined {
  const nested = valueForKeyHex(top, CIP68_NESTED_KEY_HEX)
  if (nested === undefined) return undefined

  const byPolicy = mapEntries(nested)
  if (byPolicy === undefined) return undefined

  const byAsset = mapEntries(valueForKeyHex(byPolicy, policyIdHex))
  if (byAsset === undefined) return undefined

  // The spec stores the asset name here without its CIP-67 label prefix. The prefixed form
  // is tried as a fallback rather than assumed absent, because a minter writing the whole
  // name is a mistake we can read through rather than one we need to punish.
  const bare = assetNameHex.slice(CIP67_LABEL_HEX_LEN)
  return (
    mapEntries(valueForKeyHex(byAsset, bare)) ?? mapEntries(valueForKeyHex(byAsset, assetNameHex))
  )
}

/** The value stored under a hex-encoded key in a PlutusData map. */
function valueForKeyHex(entries: unknown[], keyHex: string): unknown {
  const wanted = keyHex.toLowerCase()
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.k)) continue
    if (typeof entry.k.bytes === 'string' && entry.k.bytes.toLowerCase() === wanted) return entry.v
  }
  return undefined
}

const hexOf = (text: string): string => Buffer.from(text, 'utf8').toString('hex')

// CIP-68 version 4 wraps the metadata in a CIP-25-shaped nested map, keyed by "721":
//
//   { "721": { <policy_id>: { <asset_name>: <metadata> } } }
//
// Versions 1 to 3 put the metadata map directly in fields[0]. Both forms are live per the
// spec (`version = 1 / 2 / 3 / 4`), so both are read: a v4 asset walked as if it were v1
// finds no known field and resolves as `source: 'none'`, silently losing its name and image.
const CIP68_NESTED_KEY_HEX = hexOf('721')

// A CIP-67 asset-name label is 4 bytes (8 hex chars) prefixed to the name. The v4 nested map
// keys the asset by its name *without* that prefix, per the spec.
const CIP67_LABEL_HEX_LEN = 8

// CIP-68 metadata is a PlutusData map: a list of {k:{bytes},v:{bytes|int|list}} entries keyed
// by the hex of the field name. Walk it defensively; it is minter-controlled.
function extractCip68(
  cip68: unknown,
  policyIdHex: string,
  assetNameHex: string,
): Cip68Fields | undefined {
  if (!isRecord(cip68)) return undefined
  const datum = Object.values(cip68)[0]
  if (!isRecord(datum) || !Array.isArray(datum.fields)) return undefined

  const top = mapEntries(datum.fields[0])
  if (top === undefined) return undefined

  const entries = unwrapNested(top, policyIdHex, assetNameHex) ?? top

  const valueFor = (fieldName: string): unknown => valueForKeyHex(entries, hexOf(fieldName))
  // A PlutusData bytestring is capped at 64 bytes, so CIP-68 requires anything longer to be
  // split across a list of them. A long https or data URI in `image` is the usual case.
  // Reading only the single-bytestring form drops exactly those images on the floor.
  //
  // The chunks are joined as *bytes* and decoded once, not decoded individually and then
  // concatenated: a multi-byte UTF-8 character can straddle a chunk boundary, and decoding
  // half of one would fail (the decoder is fatal) and take the whole field with it.
  const asString = (v: unknown): string | undefined => {
    if (!isRecord(v)) return undefined
    if (Array.isArray(v.list)) {
      const parts: string[] = []
      for (const chunk of v.list) {
        if (!isRecord(chunk) || typeof chunk.bytes !== 'string') return undefined
        parts.push(chunk.bytes)
      }
      return parts.length > 0 ? hexToUtf8(parts.join('')) : undefined
    }
    return hexToUtf8(v.bytes)
  }

  // decimals is a count of places, and it comes from a datum the minter controls. It is
  // held to the same bar as the registry's decimals: a non-negative integer inside the
  // safe range. Anything else (negative, fractional, or so large that Number() would
  // silently round it) is dropped rather than handed to the wallet as a token precision,
  // because a wrong precision misrenders every balance and amount for that token.
  const asDecimals = (v: unknown): number | undefined => {
    if (!isRecord(v)) return undefined
    const raw = v.int
    if (typeof raw === 'number') {
      return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined
    }
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
      const parsed = Number(raw)
      return Number.isSafeInteger(parsed) ? parsed : undefined
    }
    return undefined
  }

  const fields: Cip68Fields = {
    name: asString(valueFor('name')),
    description: asString(valueFor('description')),
    image: asString(valueFor('logo')) ?? asString(valueFor('image')),
    ticker: asString(valueFor('ticker')),
    url: asString(valueFor('url')),
    decimals: asDecimals(valueFor('decimals')),
  }
  const hasAny =
    fields.name ||
    fields.description ||
    fields.image ||
    fields.ticker ||
    fields.url ||
    fields.decimals != null
  return hasAny ? fields : undefined
}

// CIP-25 allows a long string to be split across an array of chunks; join them. Anything
// that is not a string or array of strings is ignored rather than trusted.
function cip25String(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value.length > 0 ? value.join('') : undefined
  }
  return undefined
}

/**
 * The version-1 CIP-25 map key for an asset: its name as UTF-8 text.
 *
 * An unnamed asset is a real and common token, and its text key is the empty string. hexToUtf8
 * rejects '' (an empty *value* is absent, which is the right call for a metadata field), so
 * the empty name is handled here rather than being dropped along with it.
 */
function v1TextKey(assetNameHex: string): string | undefined {
  return assetNameHex === '' ? '' : hexToUtf8(assetNameHex)
}

interface Cip25Fields {
  name?: string
  description?: string
  image?: string
}

// Pull the CIP-25 entry for this asset out of the mint metadata. The asset key under the
// policy is the hex asset name or its text form depending on the declared version, and
// exactly one of them is used: trying both is what lets one asset pick up another's metadata
// (see below).
function extractCip25(
  minting: unknown,
  policy: string,
  assetNameHex: string,
): Cip25Fields | undefined {
  if (!isRecord(minting)) return undefined
  const nft = minting['721']
  if (!isRecord(nft)) return undefined
  const byPolicy = nft[policy]
  if (!isRecord(byPolicy)) return undefined

  // CIP-25 keys the asset differently by version, and picking the wrong representation does
  // not merely miss: it can return a *different asset's* metadata.
  //
  // Per the spec, version 1 keys the map by the asset name as UTF-8 text and version 2 by its
  // raw bytes, with the version defaulting to 1 when absent. Trying the hex form first
  // regardless would, inside a version-1 policy, look up "616263" and match an asset that is
  // literally *named* "616263" when the caller asked about the asset named "abc" (whose hex
  // is 616263). The wrong name and image would then be shown for the token.
  //
  // So exactly one key is used, chosen by the version. Decoding the v1 key from the hex
  // rather than leaning on Koios's asset_name_ascii also means a non-ASCII v1 name still
  // resolves, which the ASCII-only field could not do.
  // Only versions 1 and 2 exist, and the spec makes 1 the default. Anything else (absent, a
  // string, a future or bogus number) is read as version 1. A `>= 2` test would be worse than
  // useless: an unknown version like 3 would select the hex key on a map that is almost
  // certainly text-keyed, which is the collision path above rather than graceful degradation.
  //
  // It cannot be an identity check against the number 1 either: live data returns `version` as
  // the *string* "1.0" for a third of mainnet CIP-25 assets.
  const version = Number(nft.version) === 2 ? 2 : 1
  const assetKey = version === 2 ? assetNameHex : v1TextKey(assetNameHex)
  if (assetKey === undefined) return undefined

  const entryRaw = byPolicy[assetKey]
  if (!isRecord(entryRaw)) return undefined
  const fields: Cip25Fields = {
    name: cip25String(entryRaw.name),
    description: cip25String(entryRaw.description),
    image: cip25String(entryRaw.image),
  }
  return fields.name || fields.description || fields.image ? fields : undefined
}

function mapTokenMetadata(row: z.infer<typeof assetInfoRow>): TokenMetadata {
  const base = {
    subject: row.policy_id + row.asset_name,
    policyId: row.policy_id,
    assetName: row.asset_name,
    // Koios answers with '' for an asset whose name is empty, which is a real and common
    // case. An empty string is not a name, so it is reported as absent rather than passed
    // through as ''.
    assetNameAscii: emptyToUndefined(row.asset_name_ascii),
    fingerprint: row.fingerprint,
    supply: String(row.total_supply),
  }

  // Registry is preferred; CIP-25 mint metadata is the fallback (the usual NFT case), and
  // a CIP-68 reference-token datum is the last resort.
  //
  // Every registry field counts as "has a registry entry", not just the display ones. A
  // token registered with only `decimals` (or only a `url`) is unusual but legitimate, and
  // testing a subset here would drop that value on the floor and mislabel the source as
  // cip25 or none.
  const hasRegistry =
    row.name != null ||
    row.ticker != null ||
    row.description != null ||
    row.url != null ||
    row.decimals != null
  if (hasRegistry) {
    return {
      ...base,
      source: 'registry',
      name: row.name ?? undefined,
      ticker: row.ticker ?? undefined,
      description: row.description ?? undefined,
      decimals: row.decimals ?? undefined,
      url: row.url ?? undefined,
    }
  }

  const cip25 = extractCip25(row.minting_tx_metadata, row.policy_id, row.asset_name)
  if (cip25) {
    return {
      ...base,
      source: 'cip25',
      name: cip25.name,
      description: cip25.description,
      image: cip25.image,
    }
  }

  const cip68 = extractCip68(row.cip68_metadata, row.policy_id, row.asset_name)
  if (cip68) {
    return {
      ...base,
      source: 'cip68',
      name: cip68.name,
      ticker: cip68.ticker,
      description: cip68.description,
      decimals: cip68.decimals,
      url: cip68.url,
      image: cip68.image,
    }
  }

  return { ...base, source: 'none' }
}

export function createAssetMethods(koios: KoiosClient): AssetCapability {
  return {
    async getTokenMetadata(subjects: string[]): Promise<TokenMetadata[]> {
      if (subjects.length === 0) return []
      // Koios keys assets by lowercase hex; normalize so lookups match its response.
      const normalized = subjects.map((s) => s.toLowerCase())
      const pairs = normalized.map((s) => [
        s.slice(0, POLICY_ID_HEX_LEN),
        s.slice(POLICY_ID_HEX_LEN),
      ])

      // Send bounded chunks to stay under the upstream body cap, then merge the rows.
      const perChunk = await Promise.all(
        chunked(pairs, ASSET_INFO_CHUNK).map((chunk) => {
          const path = `/asset_info?select=${encodeURIComponent(ASSET_INFO_SELECT)}`
          return koios.batch(z.array(assetInfoRow), path, { _asset_list: chunk })
        }),
      )
      const rows = perChunk.flat()
      const bySubject = new Map(rows.map((r) => [r.policy_id + r.asset_name, r]))
      // Return in the caller's order; unknown subjects are simply absent from Koios.
      return normalized.flatMap((subject) => {
        const row = bySubject.get(subject)
        return row ? [mapTokenMetadata(row)] : []
      })
    },
  }
}
