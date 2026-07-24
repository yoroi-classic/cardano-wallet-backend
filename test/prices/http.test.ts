import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { fetchJsonOrNotFound, type FetchLike } from '../../src/prices/http.js'
import {
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../../src/domain/errors.js'

const schema = z.object({ ok: z.boolean() })

type Init = Parameters<FetchLike>[1]

const opts = (fetchImpl: FetchLike, headers?: Record<string, string>, timeoutMs = 1000) => ({
  fetchImpl,
  timeoutMs,
  upstream: 'coingecko',
  ...(headers === undefined ? {} : { headers }),
})

describe('fetchJson — redirect handling', () => {
  it('refuses to follow a redirect, so an api key is never re-sent to another origin', async () => {
    const calls: Array<{ url: string; init?: Init }> = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      // Real fetch with redirect:'error' rejects rather than replaying the request, headers and
      // all, against the redirect target. The fake stands in for exactly that.
      if (init?.redirect === 'error') throw new TypeError('unexpected redirect')
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' }
    }

    await expect(
      fetchJsonOrNotFound(
        'https://api.coingecko.com/x',
        schema,
        opts(fetchImpl, {
          'x-cg-demo-api-key': 'SECRET',
        }),
      ),
    ).rejects.toThrow(ProviderError)

    // Exactly one request went out, made with redirect:'error', and it carried the key just once:
    // there was never a second, cross-origin request the key could have leaked to.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init?.redirect).toBe('error')
    expect(calls[0]?.init?.headers?.['x-cg-demo-api-key']).toBe('SECRET')
  })
})

describe('fetchJson — 404 body handling', () => {
  it('drains the 404 body before returning undefined, so the connection can be reused', async () => {
    const text = vi.fn(async () => 'not found')
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text,
    })

    const result = await fetchJsonOrNotFound('https://api/x', schema, opts(fetchImpl))

    expect(result).toBeUndefined()
    expect(text).toHaveBeenCalledTimes(1)
  })

  it('does not turn a stalled 404 body into a negative-cache result', async () => {
    let signal: AbortSignal | undefined
    const fetchImpl: FetchLike = async (_url, init) => {
      signal = init?.signal
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () =>
          await new Promise<string>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('body aborted'), { name: 'AbortError' })),
              { once: true },
            )
          }),
      }
    }

    let caught: unknown
    try {
      await fetchJsonOrNotFound(
        'https://api/x?credential=SECRET',
        schema,
        opts(fetchImpl, undefined, 5),
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ProviderTimeoutError)
    expect((caught as ProviderTimeoutError).cause).toBe(signal?.reason)
    expect((caught as Error).message).not.toContain('SECRET')
  })
})

describe('fetchJson — timeout while reading the body', () => {
  it('maps a stalled non-2xx streaming body to a provider timeout', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' })
      response.write('SECRET_PARTIAL_BODY')
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('expected TCP address')
      const url = `http://127.0.0.1:${address.port}/?credential=SECRET_URL`

      let caught: unknown
      try {
        await fetchJsonOrNotFound(url, schema, opts(globalThis.fetch as FetchLike, undefined, 100))
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(ProviderTimeoutError)
      expect((caught as ProviderTimeoutError).cause).toMatchObject({ name: 'TimeoutError' })
      expect((caught as Error).message).not.toContain('SECRET_URL')
      expect((caught as Error).message).not.toContain('SECRET_PARTIAL_BODY')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    }
  })

  it('maps a timeout thrown from a non-2xx body reader to a provider timeout', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => {
        throw timeout
      },
    })

    let caught: unknown
    try {
      await fetchJsonOrNotFound('https://api/x', schema, opts(fetchImpl))
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ProviderTimeoutError)
    expect((caught as ProviderTimeoutError).cause).toBe(timeout)
  })

  it('keeps non-timeout body-read failures as sanitized provider errors', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => {
        throw new Error('SECRET_BODY at https://api/x?credential=SECRET_URL')
      },
    })

    let caught: unknown
    try {
      await fetchJsonOrNotFound('https://api/x?credential=SECRET_URL', schema, opts(fetchImpl))
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ProviderError)
    expect(caught).not.toBeInstanceOf(ProviderTimeoutError)
    expect((caught as ProviderError).upstreamStatus).toBe(503)
    expect((caught as ProviderError).cause).toBeUndefined()
    expect((caught as ProviderError).details).toBeUndefined()
    expect((caught as Error).message).not.toContain('SECRET')
  })

  it('maps a timeout thrown from res.json() to a provider timeout, not malformed json', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      },
      text: async () => '',
    })

    await expect(fetchJsonOrNotFound('https://api/x', schema, opts(fetchImpl))).rejects.toThrow(
      ProviderTimeoutError,
    )
  })

  it('still maps genuinely malformed json to a malformed-upstream error', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      },
      text: async () => '',
    })

    await expect(fetchJsonOrNotFound('https://api/x', schema, opts(fetchImpl))).rejects.toThrow(
      MalformedUpstreamError,
    )
  })
})
