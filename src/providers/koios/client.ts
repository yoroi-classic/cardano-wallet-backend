import { z } from 'zod'
import { MalformedUpstreamError, ProviderError, ProviderTimeoutError } from '../../domain/errors.js'

/** A minimal fetch signature so tests can inject a fake without pulling in DOM types. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string | Uint8Array
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

export interface KoiosConfig {
  /** Network-specific Koios base URL, e.g. https://preprod.koios.rest/api/v1 */
  baseUrl: string
  /** Optional bearer token for higher rate limits. */
  token?: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Injectable fetch, defaults to the global. */
  fetchImpl?: FetchLike
}

export interface KoiosRequestInit {
  method?: 'GET' | 'POST'
  body?: string | Uint8Array
  contentType?: string
}

/**
 * The shared Koios plumbing: one authenticated, timed-out, error-mapped call plus the
 * parsing helpers built on top of it. Each capability module takes a client and adds
 * only its own schemas and mapping, so a new endpoint never has to touch the transport.
 */
export interface KoiosClient {
  /** One Koios call. Maps transport, status, and JSON failures onto our error taxonomy. */
  request(path: string, init?: KoiosRequestInit): Promise<unknown>

  /** A JSON POST, which is how Koios takes batch queries. */
  postJson(path: string, body: unknown): Promise<unknown>

  /** Parse an upstream payload, raising MalformedUpstreamError on a shape mismatch. */
  parseWith<T>(schema: z.ZodType<T>, data: unknown, path: string): T

  /** Parse the first row of an upstream array, where an empty array is itself malformed. */
  parseFirst<T>(schema: z.ZodType<T>, data: unknown, path: string): T
}

export function createKoiosClient(config: KoiosConfig): KoiosClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? 10_000
  const doFetch: FetchLike = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)

  async function request(path: string, init: KoiosRequestInit = {}): Promise<unknown> {
    const url = `${baseUrl}${path}`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (config.token) headers.authorization = `Bearer ${config.token}`
    if (init.contentType) headers['content-type'] = init.contentType

    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await doFetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ProviderTimeoutError(`koios request timed out: ${path}`, cause)
      }
      throw new ProviderError(`koios request failed: ${path}`, { cause })
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ProviderError(`koios returned ${res.status} for ${path}`, {
        upstreamStatus: res.status,
        cause: body.slice(0, 500),
      })
    }

    try {
      return await res.json()
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ProviderTimeoutError(`koios response timed out: ${path}`, cause)
      }
      throw new MalformedUpstreamError(`koios returned invalid json for ${path}`, cause)
    }
  }

  function postJson(path: string, body: unknown): Promise<unknown> {
    return request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      contentType: 'application/json',
    })
  }

  function parseWith<T>(schema: z.ZodType<T>, data: unknown, path: string): T {
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      throw new MalformedUpstreamError(
        `koios response shape mismatch for ${path}`,
        parsed.error.issues,
      )
    }
    return parsed.data
  }

  function parseFirst<T>(schema: z.ZodType<T>, data: unknown, path: string): T {
    const rows = parseWith(z.array(z.unknown()), data, path)
    if (rows.length === 0) {
      throw new MalformedUpstreamError(`koios returned no rows for ${path}`)
    }
    return parseWith(schema, rows[0], path)
  }

  return { request, postJson, parseWith, parseFirst }
}
