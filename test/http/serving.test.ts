import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from '../../src/http/server.js'
import { fakeProvider } from '../support/fake-provider.js'

const TIP = { block: 3_500_000, slot: 86_400_123, epoch: 199, hash: 'aa11', blockTime: 0 }
const INFO = { version: '1.2.3', network: 'preprod', provider: 'koios' }
const SERVER_TIME = 1_784_674_800_123
const SERVER_TIME_SECONDS = Math.floor(SERVER_TIME / 1000)

afterEach(() => vi.restoreAllMocks())

describe('cors', () => {
  // The extension calls from an opaque `chrome-extension://<id>` origin that changes per build,
  // which is why the default is a wildcard rather than an allowlist we would have to keep chasing.
  it('lets a browser extension call the api', async () => {
    const app = await buildServer({ provider: fakeProvider({ getTip: async () => TIP }) })

    const res = await app.inject({
      method: 'GET',
      url: '/v1/chain/tip',
      headers: { origin: 'chrome-extension://abcdefghijklmnop' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    await app.close()
  })

  it('answers the preflight a browser sends before a POST', async () => {
    const app = await buildServer({ provider: fakeProvider() })

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/addresses/filter-used',
      headers: {
        origin: 'https://wallet.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })

    expect(res.statusCode).toBeLessThan(300)
    expect(res.headers['access-control-allow-methods']).toContain('POST')
    await app.close()
  })

  it('honours an explicit origin allowlist', async () => {
    const app = await buildServer({
      provider: fakeProvider({ getTip: async () => TIP }),
      corsOrigins: ['https://allowed.example'],
    })

    const allowed = await app.inject({
      method: 'GET',
      url: '/v1/chain/tip',
      headers: { origin: 'https://allowed.example' },
    })
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/chain/tip',
      headers: { origin: 'https://elsewhere.example' },
    })

    expect(allowed.headers['access-control-allow-origin']).toBe('https://allowed.example')
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })
})

describe('rate limit', () => {
  it('serves up to the limit and then refuses, saying how long to wait', async () => {
    const app = await buildServer({
      provider: fakeProvider({ getTip: async () => TIP }),
      rateLimit: { max: 3, windowMs: 60_000 },
    })

    const codes: number[] = []
    for (let i = 0; i < 4; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/v1/chain/tip' })
      codes.push(res.statusCode)
    }

    expect(codes).toEqual([200, 200, 200, 429])

    // The refusal comes back in the same error envelope as everything else, and says how long to
    // wait rather than leaving a client to guess and hammer.
    const refused = await app.inject({ method: 'GET', url: '/v1/chain/tip' })
    expect(refused.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: expect.stringContaining('retry in') },
    })
    await app.close()
  })

  it('ignores spoofed forwarded addresses from a direct caller', async () => {
    const app = await buildServer({
      provider: fakeProvider({ getTip: async () => TIP }),
      rateLimit: { max: 1, windowMs: 60_000 },
    })

    const first = await app.inject({
      method: 'GET',
      url: '/v1/chain/tip',
      remoteAddress: '192.0.2.10',
      headers: { 'x-forwarded-for': '198.51.100.1' },
    })
    const rotatedSpoof = await app.inject({
      method: 'GET',
      url: '/v1/chain/tip',
      remoteAddress: '192.0.2.10',
      headers: { 'x-forwarded-for': '198.51.100.2' },
    })

    expect([first.statusCode, rotatedSpoof.statusCode]).toEqual([200, 429])
    await app.close()
  })

  it('uses the first untrusted address behind an explicitly trusted proxy', async () => {
    const app = await buildServer({
      provider: fakeProvider({ getTip: async () => TIP }),
      rateLimit: { max: 1, windowMs: 60_000 },
      trustedProxies: ['127.0.0.1'],
    })

    const request = (forwardedFor: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/chain/tip',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': forwardedFor },
      })

    const firstClient = await request('198.51.100.1, 203.0.113.10')
    const sameClientWithRotatedSpoof = await request('198.51.100.2, 203.0.113.10')
    const secondClient = await request('198.51.100.1, 203.0.113.11')

    expect([
      firstClient.statusCode,
      sameClientWithRotatedSpoof.statusCode,
      secondClient.statusCode,
    ]).toEqual([200, 429, 200])
    await app.close()
  })

  // An instance that rate-limits its own orchestrator's liveness probe gets declared dead, which
  // turns a traffic spike into an outage. /health is exempt for that reason and must stay so.
  it('never rate-limits the liveness probe', async () => {
    const app = await buildServer({
      provider: fakeProvider(),
      rateLimit: { max: 1, windowMs: 60_000 },
    })

    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.statusCode).toBe(200)
    }
    await app.close()
  })

  it('is off when no limit is configured', async () => {
    const app = await buildServer({ provider: fakeProvider({ getTip: async () => TIP }) })

    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/v1/chain/tip' })
      expect(res.statusCode).toBe(200)
    }
    await app.close()
  })
})

describe('GET /v1/status', () => {
  it('reports the build, the network, and a fresh chain', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER_TIME)
    const app = await buildServer({
      provider: fakeProvider({
        getTip: async () => ({ ...TIP, blockTime: SERVER_TIME_SECONDS - 20 }),
      }),
      info: INFO,
    })

    const res = await app.inject({ method: 'GET', url: '/v1/status' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      version: '1.2.3',
      network: 'preprod',
      provider: 'koios',
      serverTime: SERVER_TIME,
      chain: 'ok',
      behindSeconds: 20,
      tip: { block: 3_500_000, epoch: 199 },
    })
    expect(res.body).toContain(`"serverTime":${SERVER_TIME}`)
    await app.close()
  })

  it('calls the chain stale when the tip is lagging', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER_TIME)
    const app = await buildServer({
      provider: fakeProvider({
        getTip: async () => ({ ...TIP, blockTime: SERVER_TIME_SECONDS - 3_600 }),
      }),
      info: INFO,
    })

    const res = await app.inject({ method: 'GET', url: '/v1/status' })

    expect(res.json()).toMatchObject({
      serverTime: SERVER_TIME,
      chain: 'stale',
      behindSeconds: 3_600,
    })
    await app.close()
  })

  // A client has to tell "the backend is unreachable" apart from "the backend is up but its chain
  // source is not": the first is a network error, the second is a maintenance notice. A 5xx here
  // would collapse them into one.
  it('answers 200 with chain: down when upstream is unreachable, not a 502', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER_TIME)
    const app = await buildServer({
      provider: fakeProvider({
        getTip: async () => {
          throw new Error('koios is unreachable')
        },
      }),
      info: INFO,
    })

    const res = await app.inject({ method: 'GET', url: '/v1/status' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      network: 'preprod',
      serverTime: SERVER_TIME,
      chain: 'down',
      tip: null,
    })
    await app.close()
  })

  // /health is liveness for the orchestrator, so it must answer instantly and must not depend on
  // upstream. Tying them together is how a slow provider gets a healthy fleet restarted.
  it('leaves /health independent of upstream', async () => {
    const app = await buildServer({
      provider: fakeProvider({
        getTip: async () => {
          throw new Error('koios is unreachable')
        },
      }),
    })

    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
    await app.close()
  })
})
