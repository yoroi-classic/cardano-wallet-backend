import { z } from 'zod'
import { noCache, type Cache } from '../../cache/index.js'
import { POLICY_ID_HEX_LEN } from '../../domain/constants.js'
import type { TokenMetadata } from '../../domain/types/assets.js'
import type { AssetCapability } from '../capabilities/assets.js'
import type { KoiosClient } from './client.js'
import { assetName, numeric, policyId } from './schema.js'

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
  traits?: Record<string, string>
}

/**
 * The field names CIP-25 reserves. Everything else in an asset's metadata map is a **trait**.
 *
 * That inversion is the whole trick, and it is forced by the spec rather than chosen: CIP-25
 * defines these names and says nothing at all about the rest of the map, so a minter's traits are
 * simply whatever they put there. `background`, `accessories`, `hats and hair` — there is no list
 * to match against, and any allowlist we invented would silently drop the traits of the next
 * collection to mint.
 *
 * So we subtract instead. `files` and `mediaType` are structural rather than descriptive, and
 * `Project` is excluded because it is a collection-level label rather than a property of the piece
 * (every Clay Nation NFT carries the same one, so surfacing it as a trait would put a 100%-common
 * "trait" at the top of every card).
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

/**
 * Traits: every metadata field the spec did not reserve, as long as it reads as a label.
 *
 * Values are flattened to strings because that is what a trait *is*: a short human-readable label
 * shown next to the picture. A nested object or a list of files is structure, not a trait, and
 * putting `[object Object]` on someone's NFT card is worse than leaving the field out.
 *
 * Chunked strings are joined, because CIP-25 splits any value over 64 bytes across an array, and a
 * long trait value would otherwise arrive as fragments.
 */
function extractTraits(entry: Record<string, unknown>): Record<string, string> | undefined {
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
 * The keys an asset's CIP-25 entry can be filed under inside its policy map, in the order they
 * should be tried. The first one that resolves to a metadata record wins.
 *
 * Per the spec, version 1 keys the map by the asset name as UTF-8 text and version 2 by its raw
 * bytes, with the version defaulting to 1 when absent. That is the key tried first, and for a
 * minter who followed the spec it is the end of it.
 *
 * The other form is then tried as a fallback, because the version field is far less reliable
 * than the spec implies. Not one CIP-25 asset sampled across either network declares version 2,
 * and yet assets keyed by raw hex exist anyway (21 on preprod), every one of them with the
 * version *absent*, so the spec's default of 1 sends the lookup to a text key that is not there.
 * Their names are 32-byte hashes, which are not valid UTF-8, so no text key could exist at all.
 * Those assets have no registry entry and no CIP-68 datum either: today they resolve as `none`,
 * and the wallet shows a token with no name and no image.
 *
 * Reading through that is what the CIP-68 path in this file already does, for the same reason: a
 * minter writing the name in the other form is a mistake we can read through rather than one we
 * need to punish.
 *
 * Order is what keeps the fallback safe, and it is not incidental. Picking the wrong
 * representation does not merely miss: it can return a *different asset's* metadata. Inside a
 * version-1 (text-keyed) policy, looking up the hex form first would search for "616263" and
 * match an asset literally *named* "616263" when the caller asked about the asset named "abc"
 * (whose hex is 616263). Trying the spec-correct key first means the fallback only runs for an
 * asset that had no entry of its own, so the worst case is confined to a policy whose assets are
 * all the same minter's to begin with, and the alternative in that case is showing nothing.
 *
 * Note what is deliberately *not* here: a fallback that strips a CIP-67 label off the name.
 * Assets with a labelled name that publish CIP-25 metadata keyed by the bare name do exist (40
 * on mainnet), but every one of them also carries a CIP-68 datum and so already resolves through
 * that path, which is both correct and richer, since a datum carries ticker, url and decimals
 * and a 721 entry does not. Adding the label fallback here would only demote those assets from
 * `cip68` to `cip25` and lose fields. CIP-25 is tried before CIP-68, so a fallback here is not
 * free: it takes assets away from a better source.
 */
function cip25Keys(nft: Record<string, unknown>, assetNameHex: string): string[] {
  const keys: string[] = []
  const add = (key: string | undefined): void => {
    if (key !== undefined && !keys.includes(key)) keys.push(key)
  }

  // Only versions 1 and 2 exist, and the spec makes 1 the default. Anything else (absent, a
  // string, a future or bogus number) is read as version 1. This cannot be an identity check
  // against the number 1: live data returns `version` as the *string* "1.0" for a third of
  // mainnet CIP-25 assets.
  const textKey = v1TextKey(assetNameHex)
  if (Number(nft.version) === 2) {
    add(assetNameHex)
    add(textKey)
  } else {
    add(textKey)
    add(assetNameHex)
  }

  return keys
}

// Pull the CIP-25 entry for this asset out of the mint metadata.
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

  for (const key of cip25Keys(nft, assetNameHex)) {
    const entryRaw = byPolicy[key]
    if (!isRecord(entryRaw)) continue
    const fields: Cip25Fields = {
      name: cip25String(entryRaw.name),
      description: cip25String(entryRaw.description),
      image: cip25String(entryRaw.image),
      traits: extractTraits(entryRaw),
    }
    if (fields.name || fields.description || fields.image || fields.traits) return fields
  }
  return undefined
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
      // Absent, never an empty object: a token with no traits has none, rather than having zero
      // of them, and a client rendering `{}` would draw an empty traits panel.
      ...(cip25.traits === undefined ? {} : { traits: cip25.traits }),
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

/**
 * How long a token's metadata is cached.
 *
 * Almost every field is fixed at mint: the name, ticker, decimals, image, fingerprint, and the
 * traits do not change, and a CIP-26 registry edit is a pull request that lands rarely. The one
 * field that drifts is `supply`, as the token is minted or burned. Ten minutes bounds how stale
 * that can get, which for a supply figure on a token screen is imperceptible, while the classifi-
 * cation a wallet actually acts on (`supply === 1` means an NFT) never flips: an NFT does not
 * start minting more of itself.
 *
 * The win is cross-user. The tokens a wallet holds are mostly the popular ones every other wallet
 * holds too, so the second request for HOSKY costs nothing.
 */
const TOKEN_METADATA_TTL_MS = 10 * 60_000

export interface AssetMethodDeps {
  /** Cache for per-subject token metadata. Defaults to none. */
  cache?: Cache
}

export function createAssetMethods(
  koios: KoiosClient,
  deps: AssetMethodDeps = {},
): AssetCapability {
  const cache = deps.cache ?? noCache

  return {
    async getTokenMetadata(subjects: string[]): Promise<TokenMetadata[]> {
      if (subjects.length === 0) return []
      // Koios keys assets by lowercase hex; normalize so lookups match its response.
      const normalized = subjects.map((s) => s.toLowerCase())

      // Serve from cache what we can, batch-fetch the rest. This is a batch load, so it cannot go
      // through cache.read (one key, one loader); it is peek-the-hits, fetch-the-misses, set-each,
      // the same shape as the DRep name cache. A wallet re-asking about tokens it holds, or a
      // second wallet asking about the same popular ones, pays nothing.
      const found = new Map<string, TokenMetadata>()
      const missing: string[] = []
      for (const subject of normalized) {
        const hit = cache.peek<TokenMetadata>(`asset:meta:${subject}`)
        if (hit !== undefined) found.set(subject, hit)
        else missing.push(subject)
      }

      if (missing.length > 0) {
        const generation = cache.generation()
        const pairs = missing.map((s) => [
          s.slice(0, POLICY_ID_HEX_LEN),
          s.slice(POLICY_ID_HEX_LEN),
        ])

        // Packed against the upstream body limit, which matters more here than anywhere else: a
        // subject is a 56-char policy id plus an asset name of 0 to 64 hex chars, so unlike a pool
        // or DRep id it is *variable* length. The old fixed count of 20 was safe by luck rather
        // than by construction, since nothing checked that 20 worst-case subjects still fit.
        const path = `/asset_info?select=${encodeURIComponent(ASSET_INFO_SELECT)}`
        const rows = await koios.batchAll(assetInfoRow, path, pairs, (chunk) => ({
          _asset_list: chunk,
        }))
        for (const row of rows) {
          const meta = mapTokenMetadata(row)
          const subject = row.policy_id + row.asset_name
          found.set(subject, meta)
          cache.setIfGeneration(`asset:meta:${subject}`, meta, TOKEN_METADATA_TTL_MS, generation)
        }
      }

      // Return in the caller's order; unknown subjects are simply absent from Koios.
      return normalized.flatMap((subject) => {
        const meta = found.get(subject)
        return meta ? [meta] : []
      })
    },
  }
}
