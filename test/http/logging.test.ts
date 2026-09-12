import { describe, expect, it } from 'vitest'
import { bech32 } from '@scure/base'
import { buildServer } from '../../src/http/server.js'
import {
  scrubMessage,
  scrubPath,
  scrubRetryEvent,
  serializeRequest,
} from '../../src/http/logging.js'
import { confirmedTxStatus } from '../../src/domain/types/transactions.js'
import { ProviderError } from '../../src/domain/errors.js'
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
    [`/v1/account/stake%2531${STAKE.slice('stake1'.length)}/utxos`, '/v1/account/[redacted]/utxos'],
    [`/v1/tx/%2561${TX_HASH.slice(1)}/status`, '/v1/tx/[redacted]/status'],
  ])('redacts an identifier containing percent-encoded characters from %s', (url, expected) => {
    expect(scrubPath(url)).toBe(expected)
  })

  it('redacts malformed percent encoding without throwing', () => {
    expect(() => scrubPath(`/v1/account/${MALFORMED_STAKE}/utxos`)).not.toThrow()
    expect(scrubPath(`/v1/account/${MALFORMED_STAKE}/utxos`)).toBe('/v1/account/[redacted]/utxos')
  })

  it('bounds nested percent-decoding work', () => {
    let deeplyEncoded = '%41'
    for (let pass = 0; pass < 4; pass += 1) {
      deeplyEncoded = encodeURIComponent(deeplyEncoded)
    }

    expect(scrubPath(`/bad/${deeplyEncoded}/path`)).toBe('/bad/[redacted]/path')
  })
})

describe('scrubMessage', () => {
  const ADDRESS = 'addr_test1qqehkck0lajq8gr28t9uxnuvgcqrc6ry3f4muzpp6v0k7lqjqfr4cmv7lx'
  // Byron addresses are base58, so nothing that recognizes bech32 or hex sees them, and the
  // address routes still accept them. Both eras, since the shapes differ.
  const BYRON_ICARUS = 'Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi'
  const BYRON_DAEDALUS =
    'DdzFFzCqrht9W56zJGEFvHHywdeXZiGVYGqVhoZj6SRrS9o2HNLmorEzZhKm7khqfBKvCaTKGLtTnQSToxuvdzJTkQqcAf6f2ErxbSKS'

  it('redacts the stake key Koios requires in the query string, keeping the endpoint', () => {
    expect(scrubMessage(`koios returned 502 for /account_txs?_stake_address=${STAKE}`)).toBe(
      'koios returned 502 for /account_txs?_stake_address=[redacted]',
    )
  })

  it.each([
    ['a testnet stake key', `koios request failed: /account_txs?_stake_address=${STAKE_TEST}`],
    ['a payment address', `blockfrost returned 502 for /addresses/${ADDRESS}/utxos`],
    ['a transaction hash', `koios returned invalid json for /tx_info?_tx_hash=${TX_HASH}`],
    ['an Icarus Byron address', `blockfrost returned 502 for /addresses/${BYRON_ICARUS}/utxos`],
    ['a Daedalus Byron address', `blockfrost request failed: /addresses/${BYRON_DAEDALUS}`],
  ])('redacts %s', (_case, message) => {
    const scrubbed = scrubMessage(message)
    expect(scrubbed).toContain('[redacted]')
    for (const identifier of [STAKE_TEST, ADDRESS, TX_HASH, BYRON_ICARUS, BYRON_DAEDALUS]) {
      expect(scrubbed).not.toContain(identifier)
    }
  })

  it('redacts every occurrence, not just the first', () => {
    const scrubbed = scrubMessage(`koios returned 502 for /x?a=${STAKE}&b=${STAKE_TEST}`)
    expect(scrubbed).toBe('koios returned 502 for /x?a=[redacted]&b=[redacted]')
  })

  it('leaves a message carrying no wallet identifier alone', () => {
    // Pool and DRep ids are public register entries, not a link to one wallet, and the endpoint
    // is the part that makes an upstream failure diagnosable.
    for (const message of [
      'koios returned 502 for /pool_info',
      'koios paged result exceeds 100000 rows for /pool_list',
      'koios returned 502 for /pool_info?_pool_bech32=pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy',
      'koios returned 502 for /drep_info?_drep_id=drep1y2v6qsjqzq8xkqz8k5vqz9k2v6qsjqzq8xkqz8k5vqz9kqk8h9x',
      // Long, but broken by ordinary punctuation and spacing, so the base58 rule cannot span it.
      'koios returned a duplicate row across pages for /account_utxos?order=tx_hash.asc,tx_index.asc',
      'koios request timed out: /credential_txs after 3 attempts against a slow upstream instance',
    ]) {
      expect(scrubMessage(message)).toBe(message)
    }
  })
})

describe('scrubRetryEvent', () => {
  it('scrubs both path-bearing fields and passes the rest through', () => {
    expect(
      scrubRetryEvent({
        path: `/account_txs?_stake_address=${STAKE}`,
        message: `koios returned 502 for /account_txs?_stake_address=${STAKE}`,
        attempt: 1,
        attempts: 3,
        code: 'UPSTREAM_ERROR',
      }),
    ).toEqual({
      path: '/account_txs?_stake_address=[redacted]',
      message: 'koios returned 502 for /account_txs?_stake_address=[redacted]',
      attempt: 1,
      attempts: 3,
      code: 'UPSTREAM_ERROR',
    })
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
        getTxStatus: async () => confirmedTxStatus(3),
        submitTx: async () => ({ txHash: TX_HASH }),
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

  it('redacts a double-encoded stake key from the application log', async () => {
    const { app, lines } = await capturingServer()
    const encodedStake = `stake%2531${STAKE.slice('stake1'.length)}`

    const response = await app.inject({
      method: 'GET',
      url: `/v1/account/${encodedStake}/utxos`,
      remoteAddress: '203.0.113.50',
    })
    await app.close()

    expect(response.statusCode).toBe(400)
    const logged = lines.join('\n')
    expect(logged).not.toContain(encodedStake)
    expect(logged).not.toContain('203.0.113.50')
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

  it('never logs or returns signed transaction material from submission', async () => {
    const { app, lines } = await capturingServer()
    // Clearly synthetic test material representing every secret-bearing category this boundary
    // must keep out of logs and responses.
    const sensitiveText =
      'addr_test1fixture credential_fixture private_key_fixture mnemonic_fixture passphrase_fixture'
    const signedTransactionBytes = Buffer.from(sensitiveText, 'utf8').toString('hex')

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tx/submit',
      payload: { cbor: signedTransactionBytes },
      remoteAddress: '192.0.2.10',
    })
    await app.close()

    const emitted = `${res.body}\n${lines.join('\n')}`
    expect(res.json()).toEqual({ txHash: TX_HASH })
    expect(emitted).not.toContain(signedTransactionBytes)
    expect(emitted).not.toContain(sensitiveText)
    for (const secret of sensitiveText.split(' ')) {
      expect(emitted).not.toContain(secret)
    }
  })

  it('does not expose a provider rejection body through the response or app log', async () => {
    const secretProviderBody =
      'addr_test1fixture credential_fixture private_key_fixture mnemonic_fixture passphrase_fixture'
    const lines: string[] = []
    const app = await buildServer({
      provider: fakeProvider({
        submitTx: async () => {
          throw new ProviderError('blockfrost returned 400 for /tx/submit', {
            upstreamStatus: 400,
            cause: secretProviderBody,
          })
        },
      }),
      logger: { level: 'info', stream: { write: (line: string) => lines.push(line) } } as never,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tx/submit',
      payload: { cbor: '84a400' },
    })
    await app.close()

    const emitted = `${res.body}\n${lines.join('\n')}`
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'blockfrost returned 400 for /tx/submit',
      },
    })
    expect(emitted).not.toContain(secretProviderBody)
    for (const secret of secretProviderBody.split(' ')) {
      expect(emitted).not.toContain(secret)
    }
  })

  it('does not return the stake key an upstream path carried into an error', async () => {
    // A real reward key-hash address on preprod, so the route validates it and the request reaches
    // the provider. The constants above are shaped like identifiers but do not carry a checksum,
    // which is all the redaction tests need and not enough to get past the route.
    const validStake = bech32.encode(
      'stake_test',
      bech32.toWords(Uint8Array.from([0xe0, ...new Uint8Array(28)])),
      1023,
    )
    const lines: string[] = []
    const app = await buildServer({
      // Koios documents /account_txs as GET with _stake_address, so the identifier is in the path
      // this message names. The caller sent it, but it must not come back out in a body a proxy
      // or a browser console will keep, and it must not reach the log at all.
      provider: fakeProvider({
        getTxHistory: async () => {
          throw new ProviderError(
            `koios returned 502 for /account_txs?_stake_address=${validStake}`,
            {
              upstreamStatus: 502,
            },
          )
        },
      }),
      info: { version: 'test', network: 'preprod', provider: 'fake' },
      logger: { level: 'info', stream: { write: (line: string) => lines.push(line) } } as never,
    })

    const res = await app.inject({ method: 'GET', url: `/v1/account/${validStake}/txs` })
    await app.close()

    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'koios returned 502 for /account_txs?_stake_address=[redacted]',
      },
    })
    expect(`${res.body}\n${lines.join('\n')}`).not.toContain(validStake)
  })
})
