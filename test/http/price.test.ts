import { describe, expect, it } from 'vitest'
import { buildServer } from '../../src/http/server.js'
import { fakeProvider } from '../support/fake-provider.js'

const server = () => buildServer({ provider: fakeProvider() })

describe('the price surface is reserved but not implemented', () => {
  // The property that matters most about a stub. A wallet that receives 0 renders a portfolio
  // worth $0.00, and the user cannot tell "the market crashed" from "the backend is unfinished".
  // One of those is a reason to panic-sell. So these endpoints refuse to answer rather than
  // inventing a number, and this test is what stops someone helpfully "fixing" that later.
  it.each([
    ['GET', '/v1/price/ada?currencies=USD,EUR', undefined],
    ['GET', '/v1/price/ada/history?range=1m&currency=USD', undefined],
    ['POST', '/v1/price/tokens', { subjects: ['aa'.repeat(28)], window: '24h' }],
    ['POST', '/v1/price/tokens/history', { subject: 'aa'.repeat(28), range: '1m' }],
  ])('%s %s answers 501, and never a price', async (method, url, payload) => {
    const app = server()

    const res = await (
      await app
    ).inject({
      method: method as 'GET' | 'POST',
      url,
      ...(payload === undefined ? {} : { payload }),
    })

    expect(res.statusCode).toBe(501)
    expect(res.json()).toEqual({
      error: { code: 'NOT_IMPLEMENTED', message: expect.stringContaining('not implemented') },
    })
    // No number a client could mistake for a quote.
    expect(res.json()).not.toHaveProperty('prices')
    expect(res.body).not.toMatch(/\b0(\.0+)?\b/)
    await (await app).close()
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
})

// The request is validated *before* the 501, on purpose. A client integrating today finds out
// immediately that it is sending the wrong shape, rather than on the day we turn the feature on,
// when the 501 it had been coding around silently turns into a 400.
describe('the price surface validates the request even though it cannot answer it', () => {
  it.each([
    ['no currencies', 'GET', '/v1/price/ada'],
    ['an empty currency list', 'GET', '/v1/price/ada?currencies='],
    ['a currency that is not a code', 'GET', '/v1/price/ada?currencies=$$$'],
    ['an unknown range', 'GET', '/v1/price/ada/history?range=forever'],
  ])('rejects %s with a 400', async (_case, method, url) => {
    const app = await server()

    const res = await app.inject({ method: method as 'GET', url })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('BAD_REQUEST')
    await app.close()
  })

  it.each([
    ['an empty subject list', { subjects: [], window: '24h' }],
    ['an unknown window', { subjects: ['aa'], window: '1y' }],
    ['more subjects than the batch allows', { subjects: Array(101).fill('aa'), window: '24h' }],
  ])('rejects %s on the token activity batch', async (_case, payload) => {
    const app = await server()

    const res = await app.inject({ method: 'POST', url: '/v1/price/tokens', payload })

    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('defaults the window and the range rather than demanding them', async () => {
    const app = await server()

    const activity = await app.inject({
      method: 'POST',
      url: '/v1/price/tokens',
      payload: { subjects: ['aa'.repeat(28)] },
    })
    const history = await app.inject({ method: 'GET', url: '/v1/price/ada/history' })

    // Accepted (and then unimplemented), rather than rejected for an absent optional.
    expect(activity.statusCode).toBe(501)
    expect(history.statusCode).toBe(501)
    await app.close()
  })
})
