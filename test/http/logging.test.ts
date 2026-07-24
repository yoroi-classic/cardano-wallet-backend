import { describe, expect, it } from 'vitest'
import { buildServer } from '../../src/http/server.js'
import { scrubPath, serializeRequest } from '../../src/http/logging.js'
import { fakeProvider } from '../support/fake-provider.js'

const STAKE = 'stake1uyehkck0lajq8gr28t9uxnuvgcqrc6ry3f4muzpp6v0k7lqjqfr4c'
const STAKE_TEST = 'stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6ry3f4muzpp6v0k7lqjqfr4c'
const TX_HASH = 'ab'.repeat(32)
const MALFORMED_STAKE = ['stake', '%', 'ZZwallet'].join('')

describe('scrubPath', () => {
  it.each([
    [`/v1/account/${STAKE}/utxos`, '/v1/account/[redacted]/utxos'],
    [`/v1/account/${STAKE}/state`, '/v1/account/[redacted]/state'],
    [`/v1/account/${STAKE_TEST}/txs`, '/v1/account/[redacted]/txs'],
    [`/v1/tx/${TX_HASH}/status`, '/v1/tx/[redacted]/status'],
  ])('removes the identifier from %s', (url, expected) => {
    expect(scrubPath(url)).toBe(expected)
  })

  it('keeps the query string, which says nothing about who is asking', () => {
    expect(scrubPath(`/v1/account/${STAKE}/txs?after=12345`)).toBe(
      '/v1/account/[redacted]/txs?after=12345',
    )
    expect(scrubPath('/v1/pools?limit=50&ticker=ADA')).toBe('/v1/pools?limit=50&ticker=ADA')
  })

  it('leaves a path carrying no identifier alone', () => {
    expect(scrubPath('/v1/chain/tip')).toBe('/v1/chain/tip')
    expect(scrubPath('/health')).toBe('/health')
  })

  it.each([
    [`/v1/account/stake%31${STAKE.slice('stake1'.length)}/utxos`, '/v1/account/[redacted]/utxos'],
    [
      `/v1/account/stake_test%31${STAKE_TEST.slice('stake_test1'.length)}/state`,
      '/v1/account/[redacted]/state',
    ],
    [`/v1/tx/%61${TX_HASH.slice(1)}/status`, '/v1/tx/[redacted]/status'],
  ])('redacts an identifier containing percent-encoded characters from %s', (url, expected) => {
    expect(scrubPath(url)).toBe(expected)
  })

  it('redacts malformed percent encoding without throwing', () => {
    expect(() => scrubPath(`/v1/account/${MALFORMED_STAKE}/utxos`)).not.toThrow()
    expect(scrubPath(`/v1/account/${MALFORMED_STAKE}/utxos`)).toBe('/v1/account/[redacted]/utxos')
  })
})

describe('serializeRequest', () => {
  // An allowlist, not a denylist. The serializer returns method and url and nothing else, so a
  // field Fastify adds in a future version cannot start leaking on its own.
  it('emits only the method and the scrubbed url', () => {
    const serialized = serializeRequest({
      method: 'GET',
      url: `/v1/account/${STAKE}/utxos`,
      // Whatever else the request object carries is simply not in the output.
      ...{ remoteAddress: '203.0.113.47', headers: { authorization: 'Bearer secret' } },
    } as never)

    expect(serialized).toEqual({ method: 'GET', url: '/v1/account/[redacted]/utxos' })
  })
})

// The property this all exists for, asserted end to end on what the app really writes rather than
// on the helper in isolation. A wallet backend that logs the stake key next to the IP has built a
// permanent record of who holds what, and that is the one thing our positioning says we do not do.
describe('the app log', () => {
  /** Captures what the app's logger actually writes. */
  async function capturingServer(): Promise<{
    app: Awaited<ReturnType<typeof buildServer>>
    lines: string[]
  }> {
    const lines: string[] = []
    const app = await buildServer({
      provider: fakeProvider({
        getAccountUtxos: async () => [],
        getTxStatus: async () => ({ seen: true, confirmations: 3 }),
      }),
      // A pino destination is any object with a write(). This is the real logger, not a stub, so
      // the serializer under test is the one production runs.
      logger: { level: 'info', stream: { write: (line: string) => lines.push(line) } } as never,
    })
    return { app, lines }
  }

  it('never writes the stake key or the caller IP', async () => {
    const { app, lines } = await capturingServer()

    await app.inject({
      method: 'GET',
      url: `/v1/account/${STAKE}/utxos`,
      remoteAddress: '203.0.113.47',
    })
    await app.close()

    const logged = lines.join('\n')
    expect(logged).not.toContain(STAKE)
    expect(logged).not.toContain('203.0.113.47')
    expect(logged).not.toContain('remoteAddress')
    // The endpoint is still logged, so traffic to it is still countable.
    expect(logged).toContain('/v1/account/[redacted]/utxos')
  })

  it('never writes the transaction hash a caller asked about', async () => {
    const { app, lines } = await capturingServer()

    await app.inject({
      method: 'GET',
      url: `/v1/tx/${TX_HASH}/status`,
      remoteAddress: '198.51.100.9',
    })
    await app.close()

    const logged = lines.join('\n')
    expect(logged).not.toContain(TX_HASH)
    expect(logged).not.toContain('198.51.100.9')
  })

  it('redacts an encoded stake key from the application log', async () => {
    const { app, lines } = await capturingServer()
    const encodedStake = `stake%31${STAKE.slice('stake1'.length)}`

    const response = await app.inject({
      method: 'GET',
      url: `/v1/account/${encodedStake}/utxos`,
      remoteAddress: '203.0.113.48',
    })
    await app.close()

    expect(response.statusCode).toBe(400)
    const logged = lines.join('\n')
    expect(logged).not.toContain(encodedStake)
    expect(logged).not.toContain(STAKE)
    expect(logged).not.toContain('203.0.113.48')
    expect(logged).toContain('/v1/account/[redacted]/utxos')
  })

  it('redacts malformed percent encoding without turning the request into a 500', async () => {
    const { app, lines } = await capturingServer()

    const response = await app.inject({
      method: 'GET',
      url: `/v1/account/${MALFORMED_STAKE}/utxos`,
      remoteAddress: '203.0.113.49',
    })
    await app.close()

    expect(response.statusCode).not.toBe(500)
    const logged = lines.join('\n')
    expect(logged).not.toContain(MALFORMED_STAKE)
    expect(logged).not.toContain('203.0.113.49')
  })
})
