import { describe, expect, it } from 'vitest'
import { buildServer } from '../../src/http/server.js'
import { createNftcdnSigner } from '../../src/media/nftcdn.js'
import { fakeProvider } from '../support/fake-provider.js'

// NFTCDN's published sample key. A public value from their docs, not a credential.
const KEY = '7FoxfBgV2k+RSz6UUts3/fG1edG7oIGXxdtIVCdalaI='
const FP = 'asset1cpfcfxay6s73xez8srvhf0pydtd9yqs8hyfawv'
const FP_2 = 'asset17q7r59zlc3dgw0venc80pdv566q6yguw03f0d9'

const withMedia = () =>
  buildServer({
    provider: fakeProvider(),
    nftcdn: createNftcdnSigner({ subdomain: 'preprod', secretKeyBase64: KEY }),
  })

const withoutMedia = () => buildServer({ provider: fakeProvider() })

describe('POST /v1/assets/media', () => {
  // The endpoint a gallery calls. One request, a hundred assets. The alternative (a redirect per
  // tile) would mean 100 requests to us for one screen, which at the default anonymous limit of
  // 120/min means a single scroll nearly exhausts the user's whole budget.
  it('signs a whole gallery in one call', async () => {
    const app = await withMedia()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/assets/media',
      payload: { fingerprints: [FP, FP_2], size: 256 },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { fingerprint: string; size: number; image: string }[]
    expect(body).toHaveLength(2)
    expect(body[0]?.fingerprint).toBe(FP)
    expect(body[0]?.image).toBe(
      `https://${FP}.preprod.nftcdn.io/image?size=256&tk=4xd-EThHgOQemNPHmWI6L9Yj5T1Ssb2Jn-Uox3ucwM8`,
    )
    // Each asset gets its own signature: a URL is not transferable between assets.
    expect(body[1]?.image).not.toContain(FP)
    await app.close()
  })

  // The mismatch that would otherwise blank the gallery. The apps ask for 720; NFTCDN serves
  // powers of two and has no such size. Reporting the size actually served lets a client lay out
  // against the real dimensions rather than the ones it asked for.
  it('snaps the 720 the apps ask for, and says what it served', async () => {
    const app = await withMedia()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/assets/media',
      payload: { fingerprints: [FP], size: 720 },
    })

    const [asset] = res.json() as { size: number; image: string }[]
    expect(asset?.size).toBe(1024)
    expect(asset?.image).toContain('size=1024')
    await app.close()
  })

  it('serves the original when no size is asked for', async () => {
    const app = await withMedia()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/assets/media',
      payload: { fingerprints: [FP] },
    })

    const [asset] = res.json() as { size?: number; image: string }[]
    expect(asset?.image).not.toContain('size=')
    expect(asset?.size).toBeUndefined()
    await app.close()
  })

  // The whole reason the signing lives on the server. A client that could see the key could be
  // decompiled, and whoever pulled it would serve their own bandwidth on our account.
  it('never leaks the signing key', async () => {
    const app = await withMedia()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/assets/media',
      payload: { fingerprints: [FP], size: 256 },
    })

    expect(res.body).not.toContain(KEY)
    // Nor any prefix of it that would help.
    expect(res.body).not.toContain(KEY.slice(0, 12))
    await app.close()
  })

  // This value is interpolated into a hostname. A fingerprint carrying a separator would not
  // merely fail: it would aim a signed URL at a host of the caller's choosing.
  it.each([
    ['a host separator', 'asset1abc.evil.example.com'],
    ['a path separator', 'asset1abc/../evil'],
    ['a broken checksum', 'asset1cpfcfxay6s73xez8srvhf0pydtd9yqs8hyfaww'],
    ['the wrong prefix', 'addr1qxy8p07'],
  ])('rejects %s with a 400', async (_case, fingerprint) => {
    const app = await withMedia()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/assets/media',
      payload: { fingerprints: [fingerprint] },
    })

    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('rejects a bad fingerprint even when it is hidden among good ones', async () => {
    const app = await withMedia()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/assets/media',
      payload: { fingerprints: [FP, 'asset1abc.evil.example.com', FP_2] },
    })

    // All or nothing: a silently short response would leave the caller to diff it against its own
    // request to notice.
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('bounds the batch', async () => {
    const app = await withMedia()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/assets/media',
      payload: { fingerprints: Array(101).fill(FP) },
    })

    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('GET /v1/assets/{fingerprint}/image', () => {
  it('redirects to the signed url', async () => {
    const app = await withMedia()

    const res = await app.inject({ method: 'GET', url: `/v1/assets/${FP}/image?size=256` })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(
      `https://${FP}.preprod.nftcdn.io/image?size=256&tk=4xd-EThHgOQemNPHmWI6L9Yj5T1Ssb2Jn-Uox3ucwM8`,
    )
    await app.close()
  })

  // 302, not 301. A signed URL is not permanent: the token dies with the key, and a client that
  // cached a 301 would keep a dead URL forever and show a broken image long after a key rotation.
  it('is a temporary redirect, because the signature is temporary', async () => {
    const app = await withMedia()

    const res = await app.inject({ method: 'GET', url: `/v1/assets/${FP}/image` })

    expect(res.statusCode).toBe(302)
    expect(res.statusCode).not.toBe(301)
    await app.close()
  })

  it('rejects a fingerprint that is not one', async () => {
    const app = await withMedia()

    const res = await app.inject({ method: 'GET', url: '/v1/assets/not-a-fingerprint/image' })

    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

// A deployment with no NFTCDN credential still serves every chain read. Only media degrades, and
// it degrades to something a client can act on rather than to a 500 or a 404.
describe('when the deployment has no media credential', () => {
  it('answers 503 and explains the fallback', async () => {
    const app = await withoutMedia()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/assets/media',
      payload: { fingerprints: [FP] },
    })

    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('FEATURE_UNAVAILABLE')
    // It tells the client what it can still do: the raw on-chain URI is in the metadata.
    expect(res.json().error.message).toContain('/v1/assets/info')
    await app.close()
  })

  it('leaves every other endpoint working', async () => {
    const app = await buildServer({
      provider: fakeProvider({
        getTip: async () => ({ block: 1, slot: 2, epoch: 3, hash: 'aa', blockTime: 1_700_000_000 }),
      }),
    })

    const res = await app.inject({ method: 'GET', url: '/v1/chain/tip' })

    expect(res.statusCode).toBe(200)
    await app.close()
  })
})
