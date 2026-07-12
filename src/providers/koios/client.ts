import { z } from 'zod'
import type { ErrorCode } from '../../domain/errors.js'
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

/**
 * Emitted each time a read fails in a way worth another attempt, just before that attempt is
 * made. Wired to the app log, this is our only visibility into how often upstream misbehaves,
 * so it carries enough to answer that without a debugger.
 *
 * A rescued read logs one of these and then answers normally; a read that runs out of attempts
 * logs one per retry and then surfaces as a 502. So the rescue rate is the count of these events
 * minus the count of upstream errors served, and both are already in the log.
 */
export interface RetryEvent {
  /** The Koios path being read, without the base URL. */
  path: string
  /** The attempt that just failed, 1-based. */
  attempt: number
  /** Total attempts this read is allowed. */
  attempts: number
  /** Error taxonomy code of the failure being retried. */
  code: ErrorCode
  message: string
}

export interface KoiosConfig {
  /** Network-specific Koios base URL, e.g. https://preprod.koios.rest/api/v1 */
  baseUrl: string
  /** Optional bearer token for higher rate limits. */
  token?: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Injectable fetch, defaults to the global. */
  fetchImpl?: FetchLike
  /**
   * Attempts per read, including the first. 1 disables retrying.
   *
   * Bounded on purpose: an upstream that is genuinely down should surface as down rather than as
   * a hang. Every attempt can burn the full `timeoutMs`, so the longest a caller can wait is
   * roughly `readAttempts * timeoutMs` plus backoff. Raising this trades the caller's patience
   * for a better chance of dodging one bad instance; it does not make a real outage go away.
   */
  readAttempts?: number
  /** Base backoff between read attempts, in ms. Grows linearly with the attempt number. */
  retryBackoffMs?: number
  /** Injectable delay, so tests exercise the backoff without waiting for it. */
  delayImpl?: (ms: number) => Promise<void>
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

/**
 * The shared Koios plumbing: one authenticated, timed-out, error-mapped, validated call per
 * method. Each capability module takes a client and adds only its own schemas and mapping, so a
 * new endpoint never has to touch the transport.
 *
 * Reads and the write are separate methods, and that separation is the point of this interface
 * rather than an accident of naming.
 *
 * A read is retried. Some of the instances behind api.koios.rest intermittently serve responses
 * that do not match Koios's own API spec: a null `active` on /drep_info, a phantom `registered`
 * column on a filtered /drep_list (cardano-community/koios-artifacts#411). One bad instance
 * behind a load balancer is exactly the case a retry is for, because the next attempt very
 * likely lands somewhere healthy.
 *
 * That only works because fetching and validating happen together, in here. A retry wrapped
 * around the fetch alone would not retry a shape mismatch at all: the response arrives whole,
 * with a 200 and well-formed JSON, and only fails later at the schema. Which is precisely the
 * failure being covered for, so the fetch and the parse have to be one retryable unit.
 *
 * A write is never retried, and cannot be: `submit` does not go through the retry path, so there
 * is no code path by which a transaction is sent twice. A transaction that actually landed,
 * resent because the response to the first attempt was garbled, is a double-spend. That is why
 * this is a separate method and not a `retry: false` argument that a future caller can forget.
 */
export interface KoiosClient {
  /** A read: fetch, validate, and retry a transient upstream failure. */
  get<T>(schema: z.ZodType<T>, path: string): Promise<T>

  /** A read of a single row, where an empty response is itself malformed. */
  getFirst<T>(schema: z.ZodType<T>, path: string): Promise<T>

  /**
   * A batch read. Koios takes its batch queries as POST bodies, so this is a POST on the wire,
   * but it is a read: it has no effect upstream, and it is retried like one.
   */
  batch<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<T>

  /** A write. Never retried. See the note on this interface. */
  submit<T>(schema: z.ZodType<T>, path: string, body: Uint8Array, contentType: string): Promise<T>
}

export function createKoiosClient(config: KoiosConfig): KoiosClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch: FetchLike = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const readAttempts = Math.max(1, config.readAttempts ?? DEFAULT_READ_ATTEMPTS)
  const backoffMs = config.retryBackoffMs ?? DEFAULT_BACKOFF_MS
  const delay =
    config.delayImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
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

  function parse<T>(schema: z.ZodType<T>, data: unknown, path: string): T {
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      throw new MalformedUpstreamError(
        `koios response shape mismatch for ${path}`,
        parsed.error.issues,
      )
    }
    return parsed.data
  }

  /**
   * Whether a failed read is worth another attempt, which comes down to one question: could a
   * different Koios instance answer this same request correctly?
   *
   * A timeout, a malformed body, or a 5xx: yes. That is upstream being unwell, and the flaky
   * instance is the whole reason this exists. A transport failure with no status at all (DNS, a
   * connection reset): yes, same answer.
   *
   * A 4xx: no. That is our own request being wrong, not upstream being unwell. A 413 for an
   * oversized batch body, or a 400 for a bad filter, fails identically on every instance, so
   * retrying it multiplies the load for nothing and delays the error the caller needs to see.
   * BadRequestError never reaches here at all, because it is raised before we ever call out.
   *
   * A 429 is the one 4xx worth arguing about, and it stays un-retried too. Being rate limited
   * means we are already sending Koios more than it will take, so the one thing that cannot
   * help is sending it more. A retry that ignores Retry-After and comes back 150ms later is not
   * a retry, it is a second violation, and it turns a throttle into a hammer at exactly the
   * moment upstream asked us to stop. Surfacing it means we find out we are over quota, which
   * is the thing actually worth knowing.
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
        const failure = err as ProviderError | ProviderTimeoutError | MalformedUpstreamError
        config.onRetry?.({
          path,
          attempt,
          attempts: readAttempts,
          code: failure.code,
          message: failure.message,
        })
        // Linear, not exponential. This is stepping past a bad instance, not backing off a rate
        // limit, and with a retry budget this small doubling buys nothing but latency for the
        // caller waiting on the answer.
        await delay(backoffMs * attempt)
      }
    }
  }

  return {
    get<T>(schema: z.ZodType<T>, path: string): Promise<T> {
      return read(path, async () => parse(schema, await request(path), path))
    },

    getFirst<T>(schema: z.ZodType<T>, path: string): Promise<T> {
      return read(path, async () => {
        const rows = parse(z.array(z.unknown()), await request(path), path)
        if (rows.length === 0) {
          throw new MalformedUpstreamError(`koios returned no rows for ${path}`)
        }
        return parse(schema, rows[0], path)
      })
    },

    batch<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<T> {
      return read(path, async () => {
        const data = await request(path, {
          method: 'POST',
          body: JSON.stringify(body),
          contentType: 'application/json',
        })
        return parse(schema, data, path)
      })
    },

    async submit<T>(
      schema: z.ZodType<T>,
      path: string,
      body: Uint8Array,
      contentType: string,
    ): Promise<T> {
      // Deliberately outside read(). See the note on KoiosClient: a resent transaction is a
      // double-spend, so a write has no retry path at all.
      const data = await request(path, { method: 'POST', body, contentType })
      return parse(schema, data, path)
    },
  }
}
