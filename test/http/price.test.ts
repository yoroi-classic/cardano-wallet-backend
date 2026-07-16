import { describe, expect, it } from 'vitest'
import { buildServer } from '../../src/http/server.js'
import {
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../../src/domain/errors.js'
import type { AdaPrice, Ohlc, TokenActivity } from '../../src/domain/types/price.js'
import { fakePriceProvider } from '../support/fake-price-provider.js'
import { fakeProvider } from '../support/fake-provider.js'

const server = (priceProvider?: ReturnType<typeof fakePriceProvider>) =>
  buildServer({ provider: fakeProvider(), ...(priceProvider ? { priceProvider } : {}) })

const ADA_PRICE: AdaPrice = {
  prices: { USD: 0.42, EUR: 0.39 },
  changePercent24h: { USD: 1.5, EUR: 1.2 },
  asOf: 1_700_000_000,
}

const CANDLE: Ohlc = { time: 1_700_000_000, open: 0.4, high: 0.45, low: 0.38, close: 0.41 }

const SUBJECT = 'aa'.repeat(28)

const ACTIVITY: TokenActivity = {
  subject: SUBJECT,
  priceAda: '0.000000001234',
  changePercent: 3.2,
  volumeAda: '184213.998877',
}

describe('GET /v1/price/ada', () => {
  it('returns the real quote from the provider', async () => {
    const app = await server(fakePriceProvider({ getAdaPrice: async () => ADA_PRICE }))

    const res = await app.inject({ method: 'GET', url: '/v1/price/ada?currencies=USD,EUR' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(ADA_PRICE)
    await app.close()
  })

  it.each([
    ['no currencies', '/v1/price/ada'],
    ['an empty currency list', '/v1/price/ada?currencies='],
    ['a currency that is not a code', '/v1/price/ada?currencies=$$$'],
  ])('rejects %s with a 400 before the provider is asked', async (_case, url) => {
    const app = await server(
      fakePriceProvider({
        getAdaPrice: async () => {
          throw new Error('must not be called')
        },
      }),
    )

    const res = await app.inject({ method: 'GET', url })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('BAD_REQUEST')
    await app.close()
  })

  it.each([
    ['a provider timeout', new ProviderTimeoutError('coingecko request timed out'), 504],
    ['an upstream 5xx', new ProviderError('coingecko returned 503', { upstreamStatus: 503 }), 502],
    [
      'a malformed upstream shape',
      new MalformedUpstreamError('coingecko response shape mismatch'),
      502,
    ],
  ])('surfaces %s as the honest error, never a price', async (_case, error, status) => {
    const app = await server(
      fakePriceProvider({
        getAdaPrice: async () => {
          throw error
        },
      }),
    )

    const res = await app.inject({ method: 'GET', url: '/v1/price/ada?currencies=USD' })

    expect(res.statusCode).toBe(status)
    // No number a client could mistake for a quote.
    expect(res.json()).not.toHaveProperty('prices')
    await app.close()
  })
})

describe('GET /v1/price/ada/history', () => {
  it('returns candles from the provider, and defaults range/currency', async () => {
    let seen: { range?: string; currency?: string } = {}
    const app = await server(
      fakePriceProvider({
        getAdaHistory: async (range, currency) => {
          seen = { range, currency }
          return [CANDLE]
        },
      }),
    )

    const res = await app.inject({ method: 'GET', url: '/v1/price/ada/history' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([CANDLE])
    expect(seen).toEqual({ range: '1m', currency: 'USD' })
    await app.close()
  })

  it('rejects an unknown range with a 400', async () => {
    const app = await server(fakePriceProvider())

    const res = await app.inject({ method: 'GET', url: '/v1/price/ada/history?range=forever' })

    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('POST /v1/price/tokens', () => {
  it('returns activity for each subject the provider resolves', async () => {
    const app = await server(fakePriceProvider({ getTokenActivity: async () => [ACTIVITY] }))

    const res = await app.inject({
      method: 'POST',
      url: '/v1/price/tokens',
      payload: { subjects: [SUBJECT], window: '24h' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([ACTIVITY])
    await app.close()
  })

  // A subject GeckoTerminal has no ADA-paired pool data for is simply absent from the batch,
  // never a zero-valued entry: the batch may legitimately come back shorter than the request.
  it('omits a subject the provider has no market for, rather than inventing one', async () => {
    const app = await server(fakePriceProvider({ getTokenActivity: async () => [] }))

    const res = await app.inject({
      method: 'POST',
      url: '/v1/price/tokens',
      payload: { subjects: [SUBJECT, 'bb'.repeat(28)] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.close()
  })

  // Regression: priceAda/volumeAda must survive the HTTP round trip as strings, never floats,
  // even for a value whose JSON-number spelling would look identical either way.
  it('keeps priceAda and volumeAda as decimal strings, not numbers', async () => {
    const app = await server(fakePriceProvider({ getTokenActivity: async () => [ACTIVITY] }))

    const res = await app.inject({
      method: 'POST',
      url: '/v1/price/tokens',
      payload: { subjects: [SUBJECT] },
    })

    const [activity] = res.json() as TokenActivity[]
    expect(typeof activity?.priceAda).toBe('string')
    expect(typeof activity?.volumeAda).toBe('string')
    expect(activity?.priceAda).toBe('0.000000001234')
    // A tell-tale sign this silently became a float: scientific notation, or trailing precision
    // loss. Neither should ever reach the wire.
    expect(activity?.priceAda).not.toMatch(/e[+-]/i)
    await app.close()
  })

  it.each([
    ['an empty subject list', { subjects: [] }],
    ['an unknown window', { subjects: [SUBJECT], window: '1y' }],
    ['more subjects than the batch allows', { subjects: Array(101).fill(SUBJECT) }],
  ])('rejects %s with a 400 before the provider is asked', async (_case, payload) => {
    const app = await server(
      fakePriceProvider({
        getTokenActivity: async () => {
          throw new Error('must not be called')
        },
      }),
    )

    const res = await app.inject({ method: 'POST', url: '/v1/price/tokens', payload })

    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('surfaces a genuine upstream failure as 502, not a partial guess', async () => {
    const app = await server(
      fakePriceProvider({
        getTokenActivity: async () => {
          throw new ProviderError('geckoterminal returned 500', { upstreamStatus: 500 })
        },
      }),
    )

    const res = await app.inject({
      method: 'POST',
      url: '/v1/price/tokens',
      payload: { subjects: [SUBJECT] },
    })

    expect(res.statusCode).toBe(502)
    expect(res.json().error.code).toBe('UPSTREAM_ERROR')
    await app.close()
  })
})

describe('POST /v1/price/tokens/history', () => {
  it('returns candles, priced in ADA, for one subject', async () => {
    const app = await server(fakePriceProvider({ getTokenHistory: async () => [CANDLE] }))

    const res = await app.inject({
      method: 'POST',
      url: '/v1/price/tokens/history',
      payload: { subject: SUBJECT, range: '1w' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([CANDLE])
    await app.close()
  })

  // No ADA market for the subject reads as "no candles", the same as a real token with no
  // trading history yet would produce, and not as an error: the request was well-formed.
  it('answers an empty array, not an error, for a subject with no ADA market', async () => {
    const app = await server(fakePriceProvider({ getTokenHistory: async () => [] }))

    const res = await app.inject({
      method: 'POST',
      url: '/v1/price/tokens/history',
      payload: { subject: SUBJECT },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.close()
  })

  it.each([
    ['a missing subject', {}],
    ['an unknown range', { subject: SUBJECT, range: 'forever' }],
  ])('rejects %s with a 400', async (_case, payload) => {
    const app = await server(fakePriceProvider())

    const res = await app.inject({ method: 'POST', url: '/v1/price/tokens/history', payload })

    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('surfaces an upstream timeout as 504', async () => {
    const app = await server(
      fakePriceProvider({
        getTokenHistory: async () => {
          throw new ProviderTimeoutError('geckoterminal request timed out')
        },
      }),
    )

    const res = await app.inject({
      method: 'POST',
      url: '/v1/price/tokens/history',
      payload: { subject: SUBJECT },
    })

    expect(res.statusCode).toBe(504)
    expect(res.json().error.code).toBe('UPSTREAM_TIMEOUT')
    await app.close()
  })
})

// A deployment with no price provider wired (a bare test harness; never a real one, since
// neither CoinGecko nor GeckoTerminal needs a credential at all) falls back to exactly the 501
// this whole surface answered before a provider existed. Still never a price of zero.
describe('the price surface with no provider wired', () => {
  it.each([
    ['GET', '/v1/price/ada?currencies=USD,EUR', undefined],
    ['GET', '/v1/price/ada/history?range=1m&currency=USD', undefined],
    ['POST', '/v1/price/tokens', { subjects: [SUBJECT], window: '24h' }],
    ['POST', '/v1/price/tokens/history', { subject: SUBJECT, range: '1m' }],
  ])('%s %s answers 501, and never a price', async (method, url, payload) => {
    const app = await server()

    const res = await app.inject({
      method: method as 'GET' | 'POST',
      url,
      ...(payload === undefined ? {} : { payload }),
    })

    expect(res.statusCode).toBe(501)
    expect(res.json()).toEqual({
      error: { code: 'NOT_IMPLEMENTED', message: expect.stringContaining('not implemented') },
    })
    expect(res.json()).not.toHaveProperty('prices')
    await app.close()
  })

  // A 501 and a 404 mean opposite things: 404 says "you called something that does not exist",
  // 501 says "you called correctly and we owe you an answer". An adapter can be written against
  // the second and cannot be written against the first.
  it('is a 501, not a 404: the route exists', async () => {
    const app = await server()

    const real = await app.inject({ method: 'GET', url: '/v1/price/ada?currencies=USD' })
    const notARoute = await app.inject({ method: 'GET', url: '/v1/price/nonsense' })

    expect(real.statusCode).toBe(501)
    expect(notARoute.statusCode).toBe(404)
    await app.close()
  })

  // The request is validated *before* the fallback, on purpose, whether or not a provider is
  // wired: a client integrating today finds out immediately that it is sending the wrong shape.
  it.each([
    ['no currencies', 'GET', '/v1/price/ada'],
    ['an unknown range', 'GET', '/v1/price/ada/history?range=forever'],
  ])('still rejects %s with a 400', async (_case, method, url) => {
    const app = await server()

    const res = await app.inject({ method: method as 'GET', url })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('BAD_REQUEST')
    await app.close()
  })
})
