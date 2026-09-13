import { createHmac } from 'node:crypto'
import { bech32 } from '@scure/base'

/**
 * Signed NFTCDN URLs for native-asset media.
 *
 * ## What this solves
 *
 * `/v1/assets/info` gives a token's `image` as whatever URI the minter wrote on chain, which is
 * usually `ipfs://Qm…`, occasionally `ar://`, sometimes a raw base64 blob, and now and then a
 * broken link. None of that is renderable by a wallet without a gateway, and none of it is sized:
 * a gallery of a hundred NFTs would pull a hundred full-resolution originals, some of them
 * megabytes of animated GIF, onto a phone. NFTCDN resolves those URIs, caches the bytes, and
 * serves a rescaled WebP.
 *
 * ## Why the signing lives here and not in the client
 *
 * NFTCDN authenticates requests with an HMAC over the URL, keyed by a secret. If a client held
 * that secret, it would be extractable from any installed extension or decompiled app within the
 * hour, and anyone who pulled it could serve their own bandwidth on our account until we noticed
 * the bill. So the key stays server-side and the wallet never sees a signed URL it did not get
 * from us.
 *
 * ## The signing scheme
 *
 * Per NFTCDN's published algorithm: build the full URL with `tk` present but **empty**, HMAC-SHA256
 * that exact string with the base64-decoded secret, and put the base64url digest back in `tk`.
 *
 * Two details that are easy to get wrong and produce a URL that 403s:
 *
 *   - The signature covers the **whole URL**, scheme and host included, not just the path. So the
 *     subdomain is part of what is signed.
 *   - It covers the **query string in order**. `tk` is appended last, after `size`, and swapping
 *     them changes the signature. This is why the query is assembled in one place rather than
 *     being built up by callers.
 */

/** NFTCDN accepts these sizes and no others: powers of two. */
export const NFTCDN_SIZES = [32, 64, 128, 256, 512, 1024] as const
export type NftcdnSize = (typeof NFTCDN_SIZES)[number]

const MAX_SIZE = 1024

export interface NftcdnConfig {
  /**
   * The subdomain in `https://<fingerprint>.<subdomain>.nftcdn.io`. On preprod and preview this
   * is the network name; on mainnet it is the account-specific subdomain from the dashboard.
   */
  subdomain: string
  /** The secret key, base64, exactly as the NFTCDN dashboard gives it. */
  secretKeyBase64: string
}

export interface NftcdnSigner {
  /**
   * A signed image URL. Omit `size` for the original, which may be large, animated, or an SVG.
   *
   * The size is snapped to a value NFTCDN actually supports, rather than passed through. See
   * `snapSize`: this is not a formality, the apps ask for 720 and NFTCDN has no such size.
   */
  imageUrl(fingerprint: string, size?: number): string

  /** A signed URL for the token's resolved metadata, as NFTCDN sees it. */
  metadataUrl(fingerprint: string): string
}

/**
 * Round a requested size up to one NFTCDN serves.
 *
 * NFTCDN only accepts powers of two from 32 to 1024. The Yoroi apps ask for 64, 128, 256, 512 and
 * **720**, and 720 is not a size NFTCDN has ever offered. Passing it through would 400 on every
 * request, and this is exactly the kind of mismatch that is invisible until a gallery is blank.
 *
 * Rounds **up**, never down: a client that asked for 720 and got 512 would upscale it and show
 * the user a blurry image, which looks like a bug in our wallet rather than a rounding decision.
 * Getting 1024 and scaling it down costs a few kilobytes and looks correct.
 */
export function snapSize(requested: number): NftcdnSize {
  const fits = NFTCDN_SIZES.find((size) => size >= requested)
  return fits ?? MAX_SIZE
}

/**
 * Whether a string is a CIP-14 asset fingerprint (`asset1…`).
 *
 * Checked properly, with the bech32 checksum, and not with a regex. This value is interpolated
 * into a hostname: a fingerprint carrying a `/` or a `.` would not merely fail, it would point
 * the signed URL at a host of the caller's choosing. The checksum also means a typo fails here
 * with a 400 rather than silently fetching a different asset's image.
 *
 * A fingerprint is a 20-byte blake2b hash under the `asset` HRP.
 */
const FINGERPRINT_BYTES = 20

export function isAssetFingerprint(value: string): boolean {
  const decoded = bech32.decodeUnsafe(value, 90)
  if (decoded === undefined || decoded.prefix !== 'asset') return false
  const bytes = bech32.fromWordsUnsafe(decoded.words)
  return bytes !== undefined && bytes.length === FINGERPRINT_BYTES
}

export function createNftcdnSigner(config: NftcdnConfig): NftcdnSigner {
  const key = Buffer.from(config.secretKeyBase64, 'base64')
  const { subdomain } = config

  /**
   * Build and sign one URL.
   *
   * `params` is an ordered list rather than an object, because the order it serializes in is part
   * of what gets signed, and object key order is a thing people reorder without thinking.
   */
  function sign(fingerprint: string, path: string, params: [string, string][]): string {
    const host = `https://${fingerprint}.${subdomain}.nftcdn.io`

    // The signed string is the finished URL with an empty `tk`, tk last.
    const unsigned = new URLSearchParams([...params, ['tk', '']])
    const token = createHmac('sha256', key)
      .update(`${host}${path}?${unsigned.toString()}`)
      .digest('base64url')

    const signed = new URLSearchParams([...params, ['tk', token]])
    return `${host}${path}?${signed.toString()}`
  }

  return {
    imageUrl(fingerprint: string, size?: number): string {
      const params: [string, string][] =
        size === undefined ? [] : [['size', String(snapSize(size))]]
      return sign(fingerprint, '/image', params)
    },

    metadataUrl(fingerprint: string): string {
      return sign(fingerprint, '/metadata', [])
    },
  }
}
