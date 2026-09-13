import { describe, expect, it } from 'vitest'
import {
  createNftcdnSigner,
  isAssetFingerprint,
  NFTCDN_SIZES,
  snapSize,
} from '../../src/media/nftcdn.js'

/**
 * The key and fingerprint from NFTCDN's own published example. Using their sample rather than one
 * of ours is the point: it lets the expected signatures below be *golden vectors* rather than
 * whatever our own code happens to produce.
 *
 * The expected `tk` values were derived independently of this implementation, by running the
 * documented algorithm (HMAC-SHA256 over the URL with an empty `tk`, base64url) through openssl.
 * So if the signing here is subtly wrong, this test fails; it cannot agree with itself.
 *
 * The key is a public sample from NFTCDN's documentation. It is not a credential.
 */
const SAMPLE_KEY = '7FoxfBgV2k+RSz6UUts3/fG1edG7oIGXxdtIVCdalaI='
const SAMPLE_FP = 'asset1cpfcfxay6s73xez8srvhf0pydtd9yqs8hyfawv'

const signer = createNftcdnSigner({ subdomain: 'preprod', secretKeyBase64: SAMPLE_KEY })

describe('nftcdn url signing', () => {
  // If any of these three drift, every image in the wallet 403s.
  it.each([
    [
      'an original image',
      signer.imageUrl(SAMPLE_FP),
      `https://${SAMPLE_FP}.preprod.nftcdn.io/image?tk=OfpHQCOgPhDzWcp0G23pYJYaCWpPIIiHCpSfWFWeAY4`,
    ],
    [
      'a resized image',
      signer.imageUrl(SAMPLE_FP, 256),
      `https://${SAMPLE_FP}.preprod.nftcdn.io/image?size=256&tk=4xd-EThHgOQemNPHmWI6L9Yj5T1Ssb2Jn-Uox3ucwM8`,
    ],
    [
      'metadata',
      signer.metadataUrl(SAMPLE_FP),
      `https://${SAMPLE_FP}.preprod.nftcdn.io/metadata?tk=roirWEeSFpwJ7ZXnJZgy8asU_e0e12t1qKmLGd_LfUk`,
    ],
  ])('matches the published algorithm for %s', (_case, actual, expected) => {
    expect(actual).toBe(expected)
  })

  // The signature covers the query string *in order*, so `tk` must come last. Putting it first
  // would produce a URL that looks perfectly reasonable and 403s on every request.
  it('appends the token after the other parameters', () => {
    const url = signer.imageUrl(SAMPLE_FP, 512)

    expect(url).toMatch(/\?size=512&tk=[\w-]+$/)
  })

  // The signature covers the whole URL, host included, so the subdomain is part of what is signed.
  // A signer built for the wrong subdomain must not accidentally produce a valid mainnet URL.
  it('signs the host, not just the path', () => {
    const other = createNftcdnSigner({ subdomain: 'mainnet', secretKeyBase64: SAMPLE_KEY })

    const preprodToken = new URL(signer.imageUrl(SAMPLE_FP)).searchParams.get('tk')
    const mainnetToken = new URL(other.imageUrl(SAMPLE_FP)).searchParams.get('tk')

    expect(mainnetToken).not.toBe(preprodToken)
  })

  it('gives a different token per asset and per size', () => {
    const a = signer.imageUrl(SAMPLE_FP, 256)
    const b = signer.imageUrl(SAMPLE_FP, 512)

    expect(a).not.toBe(b)
  })
})

describe('size snapping', () => {
  // The mismatch that would otherwise blank every image in the gallery. The Yoroi apps request
  // 64, 128, 256, 512 and **720**. NFTCDN serves powers of two only, and has never had a 720.
  it('snaps the 720 the apps actually ask for up to a size that exists', () => {
    expect(snapSize(720)).toBe(1024)
    expect(NFTCDN_SIZES).not.toContain(720)
  })

  it('passes through a size NFTCDN already supports', () => {
    for (const size of NFTCDN_SIZES) {
      expect(snapSize(size)).toBe(size)
    }
  })

  // Up, never down. A client that asked for 720 and was handed 512 would upscale it, and the user
  // would see a blurry image and conclude our wallet is broken. Scaling 1024 down costs a few
  // kilobytes and looks right.
  it.each([
    [1, 32],
    [33, 64],
    [100, 128],
    [257, 512],
    [513, 1024],
  ])('rounds %i up to %i, never down', (requested, expected) => {
    expect(snapSize(requested)).toBe(expected)
  })

  it('clamps anything beyond the largest size NFTCDN serves', () => {
    expect(snapSize(4096)).toBe(1024)
  })
})

describe('fingerprint validation', () => {
  it('accepts a real CIP-14 fingerprint', () => {
    expect(isAssetFingerprint(SAMPLE_FP)).toBe(true)
  })

  // This value is interpolated into a hostname. A fingerprint carrying a `/` or a `.` would not
  // merely fail: it would aim the signed URL at a host of the caller's choosing. So it is checked
  // with the bech32 checksum rather than a regex that might let a separator through.
  it.each([
    ['an empty string', ''],
    ['the wrong prefix', 'addr1qxy8p07tr8f0x0zfxq'],
    ['a broken checksum', 'asset1cpfcfxay6s73xez8srvhf0pydtd9yqs8hyfaww'],
    ['a path separator', 'asset1abc/../evil.example.com'],
    ['a host separator', 'asset1abc.evil.example.com'],
    ['not bech32 at all', 'asset1!!!!'],
  ])('rejects %s', (_case, value) => {
    expect(isAssetFingerprint(value)).toBe(false)
  })
})
