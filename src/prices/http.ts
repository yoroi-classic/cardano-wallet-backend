import type { z } from 'zod'
import { MalformedUpstreamError, ProviderError, ProviderTimeoutError } from '../domain/errors.js'

/** A minimal fetch signature so tests can inject a fake without pulling in DOM types. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

export interface FetchJsonOptions {
  fetchImpl: FetchLike
  timeoutMs: number
  headers?: Record<string, string>
  /** Name used in error messages, e.g. `'coingecko'` or `'geckoterminal'`. */
  upstream: string
}

/**
 * Fetch, validate, and map failures onto this service's error taxonomy.
 *
 * There is no retry here, unlike the Koios client. Koios retries because a bad answer often
 * means one unhealthy instance behind a load balancer, and the next attempt has a real chance of
 * landing somewhere else. CoinGecko and GeckoTerminal are each a single hosted API: a retry would
 * hit the same service again, and for a 429 specifically it would be sending a rate-limited
 * upstream *more* traffic at the exact moment it asked for less. So a failure here is surfaced
 * once, honestly, as a 502/504, and it is the cache in front of this that keeps call volume down
 * rather than a retry loop.
 */
export async function fetchJson<T>(
  url: string,
  schema: z.ZodType<T>,
  opts: FetchJsonOptions,
): Promise<T> {
  const result = await fetchJsonOrNotFound(url, schema, opts)
  if (result === undefined) {
    throw new ProviderError(`${opts.upstream} returned 404 for ${url}`, { upstreamStatus: 404 })
  }
  return result
}

/**
 * Like `fetchJson`, except a 404 is reported as `undefined` rather than thrown.
 *
 * GeckoTerminal answers 404 for a token address it has never indexed, and that is not an upstream
 * failure: it is upstream successfully telling us it has nothing. Callers that mean "this token
 * has no market data" use this and treat the absence as such; everything else (a timeout, a 5xx,
 * a malformed body) still throws, because those really are failures and must never be read as
 * "no data" for a subject we simply couldn't check.
 */
export async function fetchJsonOrNotFound<T>(
  url: string,
  schema: z.ZodType<T>,
  opts: FetchJsonOptions,
): Promise<T | undefined> {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await opts.fetchImpl(url, {
      headers: { accept: 'application/json', ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      throw new ProviderTimeoutError(`${opts.upstream} request timed out: ${url}`, cause)
    }
    throw new ProviderError(`${opts.upstream} request failed: ${url}`, { cause })
  }

  if (res.status === 404) return undefined

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ProviderError(
      `${opts.upstream} returned ${res.status} for ${url}${
        res.status === 429 ? ' (rate limited)' : ''
      }`,
      { upstreamStatus: res.status, cause: body.slice(0, 500) },
    )
  }

  let data: unknown
  try {
    data = await res.json()
  } catch (cause) {
    throw new MalformedUpstreamError(`${opts.upstream} returned invalid json for ${url}`, cause)
  }

  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    throw new MalformedUpstreamError(
      `${opts.upstream} response shape mismatch for ${url}`,
      parsed.error.issues,
    )
  }
  return parsed.data
}
