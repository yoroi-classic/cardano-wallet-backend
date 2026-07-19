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

const opts = (fetchImpl: FetchLike, headers?: Record<string, string>) => ({
  fetchImpl,
  timeoutMs: 1000,
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
})

describe('fetchJson — timeout while reading the body', () => {
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
