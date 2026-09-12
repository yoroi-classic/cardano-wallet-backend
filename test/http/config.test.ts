import { describe, expect, it, vi } from 'vitest'
import { createMemoryCache } from '../../src/cache/index.js'
import { buildServer } from '../../src/http/server.js'
import { createRemoteConfig, type FetchLike } from '../../src/remote-config/index.js'
import { fakeProvider } from '../support/fake-provider.js'

const CONFIG = { features: { midnightAirdrop: { enabled: true } }, dapps: { recommended: [] } }

/** A config host that answers, and can be broken on demand. */
function host(body: unknown = CONFIG) {
  let failing = false
  const fetchImpl = vi.fn<FetchLike>(async () => {
    if (failing) throw new TypeError('fetch failed')
    return { ok: true, status: 200, json: async () => body }
  })
  return { fetchImpl, breakIt: () => void (failing = true) }
}

const serve = (remoteConfig?: ReturnType<typeof createRemoteConfig>) =>
  buildServer({ provider: fakeProvider(), ...(remoteConfig ? { remoteConfig } : {}) })

describe('GET /v1/config', () => {
  it('serves the published document verbatim', async () => {
    const upstream = host()
    const app = await serve(createRemoteConfig({ fetchImpl: upstream.fetchImpl }))

    const res = await app.inject({ method: 'GET', url: '/v1/config' })

    expect(res.statusCode).toBe(200)
    // Verbatim, not transformed. A config endpoint that rewrites config becomes a second place to
    // look when a client misbehaves, and nobody remembers to look in two places.
    expect(res.json()).toEqual(CONFIG)
    await app.close()
  })

  it("defaults to our own fork, not Emurgo's", () => {
    const config = createRemoteConfig()

    // The whole point of the endpoint. Whoever controls that file controls what our users see.
    expect(config.source).toContain('yoroi-classic/yoroi-config')
    expect(config.source).not.toContain('Emurgo')
  })

  it('fetches once and then serves from cache, not once per wallet launch', async () => {
    const upstream = host()
    const config = createRemoteConfig({ fetchImpl: upstream.fetchImpl, cache: createMemoryCache() })
    const app = await serve(config)

    for (let i = 0; i < 5; i += 1) {
      await app.inject({ method: 'GET', url: '/v1/config' })
    }

    expect(upstream.fetchImpl).toHaveBeenCalledTimes(1)
    await app.close()
  })

  // A wallet that will not finish starting because a CDN is having a bad morning is a bad wallet.
  // Config is the one read here where a stale answer is nearly always better than an error.
  it('serves the last good config when the host goes down', async () => {
    let t = 1_000
    const upstream = host()
    const config = createRemoteConfig({
      fetchImpl: upstream.fetchImpl,
      cache: createMemoryCache({ now: () => t }),
      now: () => t,
    })
    const app = await serve(config)

    expect((await app.inject({ method: 'GET', url: '/v1/config' })).statusCode).toBe(200)

    // An hour later, past the 5-minute TTL, and the host is down.
    t += 60 * 60_000
    upstream.breakIt()

    const res = await app.inject({ method: 'GET', url: '/v1/config' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(CONFIG)
    await app.close()
  })

  it('fails when the host is down and nothing was ever cached', async () => {
    const upstream = host()
    upstream.breakIt()
    const app = await serve(
      createRemoteConfig({ fetchImpl: upstream.fetchImpl, cache: createMemoryCache() }),
    )

    // Nothing to fall back on. An error is the honest answer; a made-up config would be worse,
    // because a client would act on it.
    expect((await app.inject({ method: 'GET', url: '/v1/config' })).statusCode).toBe(502)
    await app.close()
  })

  // The document's contents belong to the clients and change without us, so we do not validate
  // its fields. But it has to be an *object*: an array or a string is not a config, and serving
  // one would push a crash into a wallet's launch path, which is the worst place to put one.
  it.each([
    ['an array', [1, 2, 3]],
    ['a string', 'nope'],
    ['null', null],
  ])('rejects a config that is %s', async (_case, body) => {
    const upstream = host(body)
    const app = await serve(createRemoteConfig({ fetchImpl: upstream.fetchImpl }))

    const res = await app.inject({ method: 'GET', url: '/v1/config' })

    expect(res.statusCode).toBe(502)
    await app.close()
  })

  it('answers 503 when the deployment does not serve config', async () => {
    const app = await serve()

    const res = await app.inject({ method: 'GET', url: '/v1/config' })

    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('FEATURE_UNAVAILABLE')
    await app.close()
  })
})
