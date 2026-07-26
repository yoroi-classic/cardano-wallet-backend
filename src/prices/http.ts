import type { z } from 'zod'
import { MalformedUpstreamError, ProviderError, ProviderTimeoutError } from '../domain/errors.js'

/** A minimal fetch signature so tests can inject a fake without pulling in DOM types. */
export type FetchLike = (
  input: string,
  init?: {
    headers?: Record<string, string>
    signal?: AbortSignal
    /**
     * How a redirect is handled. Always `'error'` here: an API key travels in a request header,
     * and the platform default (`'follow'`) would replay that header onto whatever origin the
     * redirect points at, leaking the credential to a third party. Refusing the redirect keeps the
     * key on the one host it was meant for.
     */
    redirect?: 'error'
  },
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

function timeoutCause(cause: unknown, signal: AbortSignal): unknown | undefined {
  if (cause instanceof Error && cause.name === 'TimeoutError') return cause

  const reason = signal.reason
  if (signal.aborted && reason instanceof Error && reason.name === 'TimeoutError') return reason

  return undefined
}

async function drainErrorBody(
  res: Awaited<ReturnType<FetchLike>>,
  signal: AbortSignal,
  upstream: string,
): Promise<void> {
  try {
    await res.text()
  } catch (cause) {
    const timeout = timeoutCause(cause, signal)
    if (timeout !== undefined) {
      throw new ProviderTimeoutError(`${upstream} response timed out`, timeout)
    }

    // Error bodies are untrusted and can contain reflected request data. Do not attach either the
    // body or its read error to the public error object.
    throw new ProviderError(`${upstream} response body could not be read`, {
      upstreamStatus: res.status,
    })
  }
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
    throw new ProviderError(`${opts.upstream} returned 404`, { upstreamStatus: 404 })
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
  let signal: AbortSignal | undefined
  let res: Awaited<ReturnType<FetchLike>>
  try {
    signal = AbortSignal.timeout(opts.timeoutMs)
    res = await opts.fetchImpl(url, {
      headers: { accept: 'application/json', ...opts.headers },
      signal,
      // Never follow a redirect: it would forward an api-key header to another origin. See FetchLike.
      redirect: 'error',
    })
  } catch (cause) {
    const timeout = signal === undefined ? undefined : timeoutCause(cause, signal)
    if (timeout !== undefined) {
      throw new ProviderTimeoutError(`${opts.upstream} request timed out`, timeout)
    }
    throw new ProviderError(`${opts.upstream} request failed`)
  }

  if (res.status === 404) {
    // A 404 is a normal, high-volume answer here (any token GeckoTerminal has not indexed), so the
    // body must be drained rather than abandoned: an unread body pins the underlying connection and
    // defeats keep-alive reuse, one leaked socket per unindexed token.
    await drainErrorBody(res, signal, opts.upstream)
    return undefined
  }

  if (!res.ok) {
    await drainErrorBody(res, signal, opts.upstream)
    throw new ProviderError(
      `${opts.upstream} returned ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`,
      { upstreamStatus: res.status },
    )
  }

  let data: unknown
  try {
    data = await res.json()
  } catch (cause) {
    // The timeout can fire while the body is still streaming in, after a 200. That is a timeout,
    // not malformed json, and must surface as a 504 like every other timeout (matching the Koios
    // client) rather than being misreported as a 502 the caller cannot retry sensibly.
    const timeout = timeoutCause(cause, signal)
    if (timeout !== undefined) {
      throw new ProviderTimeoutError(`${opts.upstream} response timed out`, timeout)
    }
    throw new MalformedUpstreamError(`${opts.upstream} returned invalid json`)
  }

  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    throw new MalformedUpstreamError(
      `${opts.upstream} response shape mismatch`,
      parsed.error.issues,
    )
  }
  return parsed.data
}
