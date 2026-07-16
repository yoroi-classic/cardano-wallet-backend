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
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch: FetchLike = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const readAttempts = Math.max(1, config.readAttempts ?? DEFAULT_READ_ATTEMPTS)
  const backoffMs = config.retryBackoffMs ?? DEFAULT_BACKOFF_MS
  const delay =
    config.delayImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    const url = `${baseUrl}${path}`
    const headers: Record<string, string> = {
      accept: 'application/json',
      project_id: config.projectId,
    }
    if (init.contentType) headers['content-type'] = init.contentType

    try {
      return await doFetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ProviderTimeoutError(`blockfrost request timed out: ${path}`, cause)
      }
      throw new ProviderError(`blockfrost request failed: ${path}`, { cause })
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
        const res = await request(path)
        if (!res.ok) return failure(res, path)
        return parse(schema, await readBody(res, path), path)
      })
    },

    getOrUndefined<T>(schema: z.ZodType<T>, path: string): Promise<T | undefined> {
      return read(path, async () => {
        const res = await request(path)
        if (res.status === 404) return undefined
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
