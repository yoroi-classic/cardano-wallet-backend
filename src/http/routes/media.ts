import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { BadRequestError, FeatureUnavailableError } from '../../domain/errors.js'
import { isAssetFingerprint, snapSize, type NftcdnSigner } from '../../media/nftcdn.js'

/**
 * Media URLs for native assets.
 *
 * Two endpoints, and the difference between them is the whole design.
 *
 * ## The batch is the one that matters
 *
 * `POST /v1/assets/media` takes up to 100 fingerprints and returns a signed URL for each. A
 * wallet opening an NFT gallery calls it **once**.
 *
 * The obvious alternative, a redirect per image, is a trap. A gallery of 100 NFTs would make 100
 * requests to us just to be told where the pictures live, which at the default anonymous rate
 * limit of 120 a minute means a single screen very nearly exhausts a user's entire budget, and
 * two screens exhaust it. It would also put us in the path of every thumbnail on every scroll,
 * for no purpose: we have nothing to add to the bytes. Handing the client the URLs and letting it
 * talk to NFTCDN directly costs us one request per gallery instead of one per tile, and is what
 * NFTCDN's own guidance recommends.
 *
 * ## The redirect exists anyway, because sometimes you just want an `<img src>`
 *
 * `GET /v1/assets/{fingerprint}/image?size=` 302s to the signed URL. It is the right tool for a
 * single asset (a token detail screen, a link preview) where one extra hop is free and being able
 * to paste a stable URL into an `img` tag is worth more than the round trip. It is the wrong tool
 * for a gallery, and the comment above the batch says so.
 *
 * ## The secret never leaves this process
 *
 * NFTCDN authenticates with an HMAC keyed by a shared secret. A client holding that key could be
 * decompiled within the hour, and whoever pulled it could serve their own bandwidth on our
 * account until the bill arrived. So we sign; the wallet only ever sees URLs we signed for it.
 */

const MAX_BATCH = 100

const mediaBody = z.object({
  fingerprints: z.array(z.string().min(1)).min(1).max(MAX_BATCH),
  /**
   * Optional. Omitted means the original: full resolution, possibly animated, possibly an SVG.
   * A gallery wants a size; a detail view may not.
   */
  size: z.coerce.number().int().min(1).max(4096).optional(),
})

const imageQuery = z.object({
  size: z.coerce.number().int().min(1).max(4096).optional(),
})

export function registerMediaRoutes(app: FastifyInstance, signer: NftcdnSigner | undefined): void {
  /** The signer, or a 503 explaining that this deployment has no media credential. */
  function requireSigner(): NftcdnSigner {
    if (signer === undefined) {
      throw new FeatureUnavailableError(
        'asset media is not configured on this deployment: NFTCDN_SUBDOMAIN and NFTCDN_KEY are ' +
          'unset. The token metadata from /v1/assets/info still carries the raw on-chain image ' +
          'URI (usually ipfs://), which a client can resolve through a gateway of its own.',
      )
    }
    return signer
  }

  app.post('/v1/assets/media', async (request) => {
    const nftcdn = requireSigner()

    const parsed = mediaBody.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError(
        `body must be { "fingerprints": [<asset1...>, ...] (1 to ${MAX_BATCH}), "size": <optional> }`,
      )
    }

    const { fingerprints, size } = parsed.data
    // Checked with the bech32 checksum, not a regex: this value is interpolated into a hostname,
    // so a fingerprint carrying a separator would aim the signed URL at a host of the caller's
    // choosing. All or nothing, so a single bad id is a visible 400 rather than a silently short
    // response the caller has to diff against its own request.
    const bad = fingerprints.filter((fp) => !isAssetFingerprint(fp))
    if (bad.length > 0) {
      throw new BadRequestError(
        `not CIP-14 asset fingerprints: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ', …' : ''}`,
      )
    }

    return fingerprints.map((fingerprint) => ({
      fingerprint,
      // The size actually served, which is not always the size asked for: NFTCDN serves powers of
      // two, and the apps ask for 720. Reporting it back means a client can lay out against the
      // real dimensions rather than the ones it hoped for.
      size: size === undefined ? undefined : snapSize(size),
      image: nftcdn.imageUrl(fingerprint, size),
      metadata: nftcdn.metadataUrl(fingerprint),
    }))
  })

  app.get('/v1/assets/:fingerprint/image', async (request, reply) => {
    const nftcdn = requireSigner()

    const { fingerprint } = request.params as { fingerprint: string }
    if (!isAssetFingerprint(fingerprint)) {
      throw new BadRequestError('fingerprint must be a CIP-14 asset fingerprint (asset1...)')
    }

    const parsed = imageQuery.safeParse(request.query)
    if (!parsed.success) {
      throw new BadRequestError('size must be a positive integer')
    }

    // 302, not 301. The signed URL is not permanent: the token expires with the key, and a client
    // that cached a 301 would keep a dead URL forever and show a broken image long after we had
    // rotated the secret.
    return reply.redirect(nftcdn.imageUrl(fingerprint, parsed.data.size), 302)
  })
}
