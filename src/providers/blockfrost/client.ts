import { z } from 'zod'
import type { ErrorCode } from '../../domain/errors.js'
import {
  ConfigError,
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../../domain/errors.js'
import { createRateLimiter } from './rate-limiter.js'

/** A minimal fetch signature so tests can inject a fake without pulling in DOM types. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string | Uint8Array
    signal?: AbortSignal
    /**
     * How to handle a 3xx from upstream. We always pass `'error'` so a redirect rejects rather
     * than being followed: following one would re-send the `project_id` auth header to whatever
     * host the redirect names, leaking the credential off Blockfrost's domain.
     */
    redirect?: 'error' | 'follow' | 'manual'
  },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
  /**
   * Response headers, read only for `Retry-After` on a 429. Optional so a test fake can omit it;
   * the global `fetch` Response satisfies it as-is.
   */
  headers?: { get: (name: string) => string | null }
}>

/**
 * Emitted each time a read fails in a way worth another attempt, just before that attempt is
 * made. See the identical event on the Koios client: this is our only visibility into how often
 * an upstream misbehaves, wired to the app log.
 */
export interface RetryEvent {
  /** The Blockfrost path being read, without the base URL. */
  path: string
  /** The attempt that just failed, 1-based. */
  attempt: number
  /** Total attempts this read is allowed. */
  attempts: number
  /** Error taxonomy code of the failure being retried. */
  code: ErrorCode
  message: string
}

export interface BlockfrostConfig {
  /** Network-specific Blockfrost base URL, e.g. https://cardano-preprod.blockfrost.io/api/v0 */
  baseUrl: string
  /**
   * Blockfrost's auth token. Sent as the `project_id` request header, not a bearer token — see
   * the `project_id` security scheme in Blockfrost's own OpenAPI spec.
   */
  projectId: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Injectable fetch, defaults to the global. */
  fetchImpl?: FetchLike
  /**
   * Attempts per read, including the first. 1 disables retrying. See the equivalent option on
   * KoiosConfig: the same reasoning applies here.
   */
  readAttempts?: number
  /** Base backoff between read attempts, in ms. Grows linearly with the attempt number. */
  retryBackoffMs?: number
  /** Injectable delay, so tests exercise the backoff without waiting for it. */
  delayImpl?: (ms: number) => Promise<void>
  /** Injectable clock for the rate limiter, so tests pace without real time. Defaults to Date.now. */
  nowImpl?: () => number
  /**
   * Sustained request rate to Blockfrost, in requests per second. Paced by a shared token bucket
   * so overlapping reads share one budget. Defaults to Blockfrost's own sustained ceiling.
   */
  requestsPerSecond?: number
  /**
   * How many requests may go out back-to-back before the rate limiter starts pacing. Defaults to
   * the size of Blockfrost's burst bucket.
   */
  burstSize?: number
  /**
   * How many times a 429 is retried, honoring its `Retry-After`, before the error surfaces. Reads
   * only; a write (submit) is never retried. Defaults to 3.
   */
  rateLimitRetries?: number
  /** Called before each retry. See RetryEvent. */
  onRetry?: (event: RetryEvent) => void
}

interface RequestInit {
  method?: 'GET' | 'POST'
  body?: string | Uint8Array
  contentType?: string
}

const DEFAULT_READ_ATTEMPTS = 3
const DEFAULT_BACKOFF_MS = 150
const DEFAULT_TIMEOUT_MS = 10_000
// Blockfrost's published limits: ~10 requests/second sustained, drawn from a 500-slot burst
// bucket that refills at that rate. Matching them here keeps a large batch from tripping the 429.
const DEFAULT_REQUESTS_PER_SECOND = 10
const DEFAULT_BURST_SIZE = 500
const DEFAULT_RATE_LIMIT_RETRIES = 3
// Ceiling on how long a single `Retry-After` will hold a read, so a hostile or absurd header value
// cannot park a request indefinitely.
const MAX_RETRY_AFTER_MS = 30_000

// The timer range shared by setTimeout and AbortSignal.timeout: above 2^31-1 ms the value overflows
// a signed 32-bit int and the timer fires almost immediately, so any duration we hand them (a
// request timeout, a backoff) has to stay at or below this. A value above it must fail at startup,
// not turn into a request that "times out" instantly on every call.
const MAX_TIMER_MS = 2_147_483_647
// Upper bounds for the count knobs. None has a legitimate reason to be enormous: a retry budget past
// ~100 only turns a dead upstream into a longer hang, and a burst past 100k stops being a rate limit
// at all (it would admit a flood larger than any real provider's bucket, i.e. disable the limiter).
const MAX_RETRIES = 100
const MAX_BURST = 100_000
// The rate knob feeds the limiter as `requestsPerSecond / 1000` tokens per ms. Below ~1e-3 req/s
// that conversion loses precision and eventually underflows toward a subnormal or zero, which would
// make every post-burst request wait forever; a single refill wait would also blow past MAX_TIMER_MS.
// The upper bound is really just "finite and not absurd" — past it, pacing is meaningless anyway.
const MIN_REQUESTS_PER_SECOND = 1e-3
const MAX_REQUESTS_PER_SECOND = 1_000_000

/**
 * How a single numeric knob is bounded. Three shapes, each with its floor and ceiling spelled out
 * in one place so there is no unbounded edge left to find:
 *  - `count`: a whole number of things (retries, burst slots). Must be a *safe* integer in range —
 *    `Number.isInteger` is not enough, because 2**53 is an "integer" that no longer increments.
 *  - `duration`: milliseconds handed to a timer. Finite, at or above its floor, at or below the
 *    timer range so it cannot silently fire early.
 *  - `rate`: requests per second. Finite and within the band where the limiter's per-ms conversion
 *    stays a normal, non-underflowing number.
 */
type NumericBound =
  { kind: 'count'; min: number; max: number } | { kind: 'duration'; min: number } | { kind: 'rate' }

/**
 * Validate an optional numeric knob at construction, throwing `ConfigError` on anything outside its
 * bound. Left unchecked, a NaN, an Infinity, an unsafe integer, an over-range duration, or a
 * subnormal rate slips into the retry and pacing math and turns a bound into an unbounded loop
 * (`attempt >= NaN` is never true), a timer that fires instantly, or a wait that never ends. A
 * hand-built config is caught here, at startup, rather than as a request that never returns.
 */
function checkNumber(
  value: number | undefined,
  fallback: number,
  name: string,
  bound: NumericBound,
): number {
  if (value === undefined) return fallback
  const reject = (expected: string): never => {
    throw new ConfigError(`blockfrost ${name} must be ${expected}, got ${String(value)}`)
  }
  switch (bound.kind) {
    case 'count':
      if (!Number.isSafeInteger(value) || value < bound.min || value > bound.max) {
        reject(`a safe integer in [${bound.min}, ${bound.max}]`)
      }
      return value
    case 'duration':
      if (!Number.isFinite(value) || value < bound.min || value > MAX_TIMER_MS) {
        reject(`a finite number of ms in [${bound.min}, ${MAX_TIMER_MS}]`)
      }
      return value
    case 'rate':
      if (
        !Number.isFinite(value) ||
        value < MIN_REQUESTS_PER_SECOND ||
        value > MAX_REQUESTS_PER_SECOND
      ) {
        reject(`a finite rate in [${MIN_REQUESTS_PER_SECOND}, ${MAX_REQUESTS_PER_SECOND}] req/s`)
      }
      return value
  }
}

/**
 * The shared Blockfrost plumbing: one authenticated, timed-out, error-mapped, validated call per
 * method, mirroring the Koios client's shape.
 *
 * There is no per-path "heavy timeout" tier here the way the Koios client has one. That split
 * exists there because Koios's bimodal latency on specific endpoints is a *measured* fact
 * (cardano-community/koios-artifacts, see the Koios client's own comment). There is no equivalent
 * measurement for Blockfrost's hosted service yet, so every read gets the same flat timeout for
 * now. If a specific Blockfrost endpoint turns out to need more room, that is a follow-up backed
 * by the same kind of evidence, not a guess baked in up front.
 *
 * `getOrUndefined` exists because Blockfrost expresses "this does not exist" as a plain 404 on an
 * otherwise ordinary resource (an account never seen on chain, an address that has never
 * appeared, a transaction not yet on chain), rather than an empty array the way Koios's batch
 * endpoints do. Each capability module decides what a 404 *means* for its own read; the client
 * only decides that a 404 is not itself an error worth throwing.
 */
export interface BlockfrostClient {
  /** A read: fetch, validate, and retry a transient upstream failure. */
  get<T>(schema: z.ZodType<T>, path: string): Promise<T>

  /**
   * A read where a 404 is a legitimate answer meaning "not on chain", not a failure. Returns
   * `undefined` for a 404, the parsed body otherwise. Still retried on a transient failure.
   */
  getOrUndefined<T>(schema: z.ZodType<T>, path: string): Promise<T | undefined>

  /**
   * A write. Never retried, for the same reason as the Koios client's `submit`: a transaction
   * resent because the response to the first attempt was garbled is a double-spend.
   */
  submit<T>(schema: z.ZodType<T>, path: string, body: Uint8Array, contentType: string): Promise<T>
}

export function createBlockfrostClient(config: BlockfrostConfig): BlockfrostClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const doFetch: FetchLike = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const delay =
    config.delayImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = config.nowImpl ?? (() => Date.now())

  // Every numeric knob is validated up front against an explicit bound (see NumericBound). A
  // finite, in-range value or the default; anything else throws here rather than silently
  // corrupting the retry or pacing math into a loop that never ends or a timer that fires instantly.
  const timeoutMs = checkNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs', {
    kind: 'duration',
    min: 1,
  })
  const readAttempts = checkNumber(config.readAttempts, DEFAULT_READ_ATTEMPTS, 'readAttempts', {
    kind: 'count',
    min: 1,
    max: MAX_RETRIES,
  })
  const backoffMs = checkNumber(config.retryBackoffMs, DEFAULT_BACKOFF_MS, 'retryBackoffMs', {
    kind: 'duration',
    min: 0,
  })
  const rateLimitRetries = checkNumber(
    config.rateLimitRetries,
    DEFAULT_RATE_LIMIT_RETRIES,
    'rateLimitRetries',
    { kind: 'count', min: 0, max: MAX_RETRIES },
  )
  const requestsPerSecond = checkNumber(
    config.requestsPerSecond,
    DEFAULT_REQUESTS_PER_SECOND,
    'requestsPerSecond',
    { kind: 'rate' },
  )
  const burstSize = checkNumber(config.burstSize, DEFAULT_BURST_SIZE, 'burstSize', {
    kind: 'count',
    min: 1,
    max: MAX_BURST,
  })

  // One shared limiter for every request this client makes, so overlapping reads draw on a single
  // budget rather than each opening its own window onto the same upstream.
  const limiter = createRateLimiter(requestsPerSecond, burstSize, { now, delay })

  /** The `Retry-After` on a 429, in ms: an integer number of seconds, or an HTTP date. */
  function retryAfterMs(res: Awaited<ReturnType<FetchLike>>): number | undefined {
    const raw = res.headers?.get('retry-after')
    if (raw === null || raw === undefined || raw === '') return undefined
    const seconds = Number(raw)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const at = Date.parse(raw)
    if (!Number.isNaN(at)) return Math.max(0, at - now())
    return undefined
  }

  async function fetchOnce(
    path: string,
    init: RequestInit,
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    const url = `${baseUrl}${path}`
    const headers: Record<string, string> = {
      accept: 'application/json',
      project_id: config.projectId,
    }
    if (init.contentType) headers['content-type'] = init.contentType

    // Take a token before every attempt, so retries and the initial call all count against the
    // same rate budget.
    await limiter.acquire()
    try {
      return await doFetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow a redirect: doing so would re-send the `project_id` header to the redirect
        // target and leak the credential to another host. A 3xx here is not something we expect
        // from Blockfrost anyway, so treat it as the failure it is rather than chasing it.
        redirect: 'error',
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ProviderTimeoutError(`blockfrost request timed out: ${path}`, cause)
      }
      throw new ProviderError(`blockfrost request failed: ${path}`, { cause })
    }
  }

  /**
   * A single HTTP round trip, plus a bounded retry on a 429. The rate limiter above is meant to
   * keep us under Blockfrost's ceiling in the first place; this is the safety net for when we go
   * over anyway (a shared deployment, a burst from another caller). A 429 is retried only for a
   * read — `retryOn429` is false for a submit, because a write must never be replayed — and only
   * up to `rateLimitRetries` times, honoring the server's own `Retry-After`.
   */
  async function request(
    path: string,
    init: RequestInit = {},
    retryOn429 = false,
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetchOnce(path, init)
      if (res.status !== 429 || !retryOn429 || attempt >= rateLimitRetries) return res

      // When the server told us how long to wait, and that is longer than we are willing to hold a
      // request, surface the 429 rather than retrying after a shorter wait. Retrying early would
      // hit the server before it said it was safe, which only deepens the throttle it just asked
      // us to back off from. `failure()` will read the body when this is returned, so leave it.
      const serverDelay = retryAfterMs(res)
      if (serverDelay !== undefined && serverDelay > MAX_RETRY_AFTER_MS) return res

      // Retrying: drain the body we are discarding so its socket is freed rather than pinned open.
      await res.text().catch(() => undefined)
      // A server-directed wait is honored as-is (already known to be within the cap); without one,
      // fall back to our own linear backoff, itself capped so it cannot run away.
      const waitMs = serverDelay ?? Math.min(backoffMs * (attempt + 1), MAX_RETRY_AFTER_MS)
      config.onRetry?.({
        path,
        attempt: attempt + 1,
        attempts: rateLimitRetries + 1,
        code: 'UPSTREAM_ERROR',
        message: `blockfrost returned 429 for ${path}`,
      })
      await delay(waitMs)
    }
  }

  async function readBody(res: Awaited<ReturnType<FetchLike>>, path: string): Promise<unknown> {
    try {
      return await res.json()
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ProviderTimeoutError(`blockfrost response timed out: ${path}`, cause)
      }
      throw new MalformedUpstreamError(`blockfrost returned invalid json for ${path}`, cause)
    }
  }

  function parse<T>(schema: z.ZodType<T>, data: unknown, path: string): T {
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      throw new MalformedUpstreamError(
        `blockfrost response shape mismatch for ${path}`,
        parsed.error.issues,
      )
    }
    return parsed.data
  }

  async function failure(res: Awaited<ReturnType<FetchLike>>, path: string): Promise<never> {
    const body = await res.text().catch(() => '')
    throw new ProviderError(`blockfrost returned ${res.status} for ${path}`, {
      upstreamStatus: res.status,
      cause: body.slice(0, 500),
    })
  }

  /**
   * Whether a failed read is worth another attempt. Identical philosophy to the Koios client: a
   * timeout, a malformed body, or a 5xx is upstream being unwell, worth trying again in case the
   * next attempt lands somewhere healthier. A 4xx (400, 403, 404, 418, 425, 429) is our own
   * request being wrong or upstream deliberately asking us to stop, and retrying it multiplies
   * load for an answer that will not change.
   */
  function isTransient(err: unknown): boolean {
    if (err instanceof ProviderTimeoutError || err instanceof MalformedUpstreamError) return true
    if (err instanceof ProviderError) {
      return err.upstreamStatus === undefined || err.upstreamStatus >= 500
    }
    return false
  }

  async function read<T>(path: string, load: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await load()
      } catch (err) {
        if (attempt >= readAttempts || !isTransient(err)) throw err
        const problem = err as ProviderError | ProviderTimeoutError | MalformedUpstreamError
        config.onRetry?.({
          path,
          attempt,
          attempts: readAttempts,
          code: problem.code,
          message: problem.message,
        })
        // Linear, not exponential: this is stepping past a transient blip, not backing off a
        // rate limit, so doubling would only add latency for no benefit at this small a budget.
        await delay(backoffMs * attempt)
      }
    }
  }

  return {
    get<T>(schema: z.ZodType<T>, path: string): Promise<T> {
      return read(path, async () => {
        const res = await request(path, {}, true)
        if (!res.ok) return failure(res, path)
        return parse(schema, await readBody(res, path), path)
      })
    },

    getOrUndefined<T>(schema: z.ZodType<T>, path: string): Promise<T | undefined> {
      return read(path, async () => {
        const res = await request(path, {}, true)
        if (res.status === 404) {
          // Drain the body before returning. A 404 is a routine "not on chain" answer here, but
          // it still carries a response body; leaving it unread holds the underlying connection
          // open, and enough of them at once (a wallet restore checks many addresses) exhausts the
          // connection pool. Reading it to completion lets the socket be reused.
          await res.text().catch(() => undefined)
          return undefined
        }
        if (!res.ok) return failure(res, path)
        return parse(schema, await readBody(res, path), path)
      })
    },

    async submit<T>(
      schema: z.ZodType<T>,
      path: string,
      body: Uint8Array,
      contentType: string,
    ): Promise<T> {
      // Deliberately outside read(): see the note on BlockfrostClient above.
      const res = await request(path, { method: 'POST', body, contentType })
      if (!res.ok) return failure(res, path)
      return parse(schema, await readBody(res, path), path)
    },
  }
}
