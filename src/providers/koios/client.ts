import { z } from 'zod'
import type { ErrorCode } from '../../domain/errors.js'
import {
  ConfigError,
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../../domain/errors.js'
import { KOIOS_BODY_LIMIT_BYTES, packBySize } from './schema.js'

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
  headers?: {
    get(name: string): string | null
  }
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
  /** Per-request timeout in milliseconds, for the light reads. */
  timeoutMs?: number
  /**
   * Per-request timeout for the endpoints that assemble a lot of rows. See HEAVY_PATHS: the point
   * is to sit between Koios's two latency modes, so a fast instance is never cut off and a slow
   * one is abandoned quickly enough for the retry to land somewhere else.
   */
  heavyTimeoutMs?: number
  /** Injectable fetch, defaults to the global. */
  fetchImpl?: FetchLike
  /**
   * Attempts per read, including the first. 1 disables retrying.
   *
   * Must be a safe integer from 1 through 100. 0 is rejected rather than treated as "make no request":
   * callers that want no retries use 1, because every read still needs its first attempt.
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
  /**
   * Request-body budget in bytes. Defaults to the limit Koios documents. Worth setting for a
   * self-hosted or proxied instance with a different cap, though batchAll also adopts a smaller
   * limit if upstream ever names one.
   */
  bodyLimitBytes?: number
}

interface RequestInit {
  method?: 'GET' | 'POST'
  body?: string | Uint8Array
  contentType?: string
  headers?: Record<string, string>
}

const DEFAULT_READ_ATTEMPTS = 3
// A retry budget past ~100 only turns a dead upstream into a longer hang. Keep this aligned with
// the Blockfrost provider so a hand-built config cannot create an effectively endless request loop.
const MAX_READ_ATTEMPTS = 100
const DEFAULT_BACKOFF_MS = 150
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMER_MS = 2_147_483_647
const KOIOS_PAGE_SIZE = 1_000
const KOIOS_MAX_PAGED_ROWS = 100_000

interface ResponseWithMetadata {
  data: unknown
  status: number
  contentRange: string | null
}

export type KoiosContentRange = { start: number; end: number; total: number } | { total: 0 } | null

export interface KoiosBatchPage<Row> {
  rows: Row[]
  status: number
  range: KoiosContentRange
}

/**
 * Endpoints that are slow upstream, and how long to give them.
 *
 * Koios is **bimodal**, not merely slow, and that is what decides the number. Measured on mainnet,
 * `/pool_info` answers in about 7.2 to 7.8 seconds most of the time and in 22 to 52 seconds the
 * rest of the time. It is not a distribution with a long tail; it is two distributions, and which
 * one you get depends on which instance the load balancer picks.
 *
 * So the timeout is set to sit **between the two modes**: high enough that a fast instance is
 * never cut off (7.8s of work under a 15s budget has headroom to spare), low enough that a slow
 * one is abandoned quickly so the retry can land somewhere else. Raising it to 60s to "make it
 * work" would be the wrong move: it would convert a fast failure into a minute of a user staring
 * at a spinner, on a request another instance would have answered in seven seconds.
 *
 * The paths listed are the ones that ask Koios to assemble a lot of rows. The light reads (`/tip`,
 * `/epoch_params`) keep the 10s default, because for them a 15s wait is already a broken upstream.
 */
const HEAVY_TIMEOUT_MS = 15_000
export const HEAVY_PATHS = [
  '/pool_info',
  '/pool_list',
  '/tx_info',
  '/asset_info',
  '/drep_info',
  '/drep_metadata',
  '/account_utxos',
  '/account_txs',
  // Address-keyed row assembly, the same weight as their account-keyed siblings above: a wallet
  // with no stake credential reads its UTxOs and history here, and both walk every matching page.
  '/address_utxos',
  '/address_txs',
  '/credential_txs',
]

export const timeoutFor = (path: string, base: number, heavy: number): number =>
  HEAVY_PATHS.some((heavyPath) => path.startsWith(heavyPath)) ? heavy : base

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

  /**
   * Retry a composed multi-request read from its beginning. A page-level retry cannot repair a
   * result set that changed between offsets, so incremental readers use this around the whole
   * stream walk and create fresh cursors on every attempt.
   */
  readWithRetry<T>(path: string, load: () => Promise<T>): Promise<T>

  /** A read of a single row, where an empty response is itself malformed. */
  getFirst<T>(schema: z.ZodType<T>, path: string): Promise<T>

  /**
   * A batch read. Koios takes its batch queries as POST bodies, so this is a POST on the wire,
   * but it is a read: it has no effect upstream, and it is retried like one.
   */
  batch<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<T>

  /**
   * Make one validated batch-page request without its own retry. This belongs inside
   * `readWithRetry`, so any Content-Range or shape failure restarts the complete logical read
   * rather than retrying one offset against an older prefix.
   */
  batchPageOnce<Row>(
    rowSchema: z.ZodType<Row>,
    path: string,
    body: unknown,
  ): Promise<KoiosBatchPage<Row>>

  /**
   * A paged batch read. Koios/PostgREST caps large result sets and answers partial requests with
   * `Content-Range`; this walks explicit `limit`/`offset` pages until the exact total is
   * satisfied. Koios's RPC POST endpoints ignore the HTTP `Range` request header, so query
   * parameters are deliberately used even though table GET endpoints support that header.
   *
   * Koios does not expose a snapshot token spanning separate HTTP requests. Stable ordering,
   * totals, range continuity and optional row keys detect the observable forms of mid-read
   * churn, but cannot turn several upstream requests into a database-atomic snapshot. Account
   * callers therefore still refresh current state rather than treating one read as a durable
   * checkpoint.
   */
  batchAllPages<Row>(
    rowSchema: z.ZodType<Row>,
    path: string,
    body: unknown,
    rowKey?: (row: Row) => string,
  ): Promise<Row[]>

  /**
   * A batch read over more items than fit in one request body: pack them into as few requests as
   * the byte budget allows, run those, and concatenate the rows.
   *
   * This is where the body limit lives, so no caller has to know it exists. `toBody` turns a
   * chunk into the real request body, which is also what gets measured, so a body carrying extra
   * flags is accounted for rather than being a surprise on the wire.
   *
   * If upstream rejects a chunk with a 413 anyway and names a smaller limit, the limit is lowered
   * for the life of this client, the items are repacked, and the batch is attempted once more. A
   * proxy or a self-hosted Koios with a tighter cap therefore costs one failed request, once,
   * rather than a redeploy.
   */
  batchAll<Row, Item>(
    rowSchema: z.ZodType<Row>,
    path: string,
    items: Item[],
    toBody: (chunk: Item[]) => unknown,
  ): Promise<Row[]>

  /**
   * The body-budget packing under batchAll, exposed so a read that does more than one request per
   * chunk can inherit it. Pack `items` into as few request bodies as the byte budget allows, run
   * `send` on each body concurrently, and concatenate the rows. If upstream rejects a body with a
   * 413 that names a smaller limit, that limit is adopted for the life of this client, the items
   * are repacked, and the whole run is attempted once more.
   *
   * `send` turns a built request body into rows, so a caller can wrap paging or extra behaviour
   * around each chunk and still get the packing and the 413 adaptation for free. This is how the
   * address-set reads page each chunk without duplicating the limit-learning batchAll owns.
   */
  packAdaptively<Row, Item>(
    items: Item[],
    toBody: (chunk: Item[]) => unknown,
    send: (body: unknown) => Promise<Row[]>,
  ): Promise<Row[]>

  /** The current request-body budget in bytes. Lowered if upstream ever says it is smaller. */
  readonly bodyLimit: number

  /** A write. Never retried. See the note on this interface. */
  submit<T>(schema: z.ZodType<T>, path: string, body: Uint8Array, contentType: string): Promise<T>
}

/**
 * The limit Koios names in its own 413, if it named one.
 *
 * The message is "Payload too large, body length was 6022. Please ensure your request body size
 * is below 5120 bytes", so upstream tells us the answer and we would otherwise ignore it.
 */
function limitFrom413(err: unknown): number | undefined {
  if (!(err instanceof ProviderError) || err.upstreamStatus !== 413) return undefined
  const said = /body size is below (\d+) bytes/.exec(String(err.details))
  const limit = said?.[1] === undefined ? NaN : Number(said[1])
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined
}

function asReadAttempts(value: number | undefined): number {
  const attempts = value ?? DEFAULT_READ_ATTEMPTS
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_READ_ATTEMPTS) {
    throw new RangeError(
      `readAttempts must be a safe integer in [1, ${MAX_READ_ATTEMPTS}]; use 1 to disable retries`,
    )
  }
  return attempts
}

function asBoundedNumber(
  value: number | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new ConfigError(`koios ${name} must be a safe integer in [${min}, ${max}]`)
  }
  return result
}

export function createKoiosClient(config: KoiosConfig): KoiosClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const timeoutMs = asBoundedNumber(
    config.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    'timeoutMs',
    1,
    MAX_TIMER_MS,
  )
  const heavyTimeoutMs = asBoundedNumber(
    config.heavyTimeoutMs,
    HEAVY_TIMEOUT_MS,
    'heavyTimeoutMs',
    1,
    MAX_TIMER_MS,
  )
  const doFetch: FetchLike = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  // Not a constant, because upstream may tell us it is smaller. See batchAll.
  let bodyLimit = asBoundedNumber(
    config.bodyLimitBytes,
    KOIOS_BODY_LIMIT_BYTES,
    'bodyLimitBytes',
    1,
    Number.MAX_SAFE_INTEGER,
  )
  const readAttempts = asReadAttempts(config.readAttempts)
  const backoffMs = asBoundedNumber(
    config.retryBackoffMs,
    DEFAULT_BACKOFF_MS,
    'retryBackoffMs',
    0,
    MAX_TIMER_MS,
  )
  const delay =
    config.delayImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  async function requestWithMetadata(
    path: string,
    init: RequestInit = {},
  ): Promise<ResponseWithMetadata> {
    const url = `${baseUrl}${path}`
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers }
    if (config.token) headers.authorization = `Bearer ${config.token}`
    if (init.contentType) headers['content-type'] = init.contentType

    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await doFetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        // Per-path, because Koios is bimodal rather than uniformly slow. See HEAVY_PATHS.
        signal: AbortSignal.timeout(timeoutFor(path, timeoutMs, heavyTimeoutMs)),
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
      return {
        data: await res.json(),
        status: res.status,
        contentRange: res.headers?.get('content-range') ?? null,
      }
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ProviderTimeoutError(`koios response timed out: ${path}`, cause)
      }
      throw new MalformedUpstreamError(`koios returned invalid json for ${path}`, cause)
    }
  }

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    return (await requestWithMetadata(path, init)).data
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

  function batch<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<T> {
    return read(path, async () => {
      const data = await request(path, {
        method: 'POST',
        body: JSON.stringify(body),
        contentType: 'application/json',
      })
      return parse(schema, data, path)
    })
  }

  function parseContentRange(value: string, path: string): Exclude<KoiosContentRange, null> {
    if (value === '*/0') return { total: 0 }

    const match = /^(\d+)-(\d+)\/(\d+)$/.exec(value)
    if (!match) {
      throw new MalformedUpstreamError(`koios returned invalid Content-Range for ${path}`)
    }

    const start = Number(match[1])
    const end = Number(match[2])
    const total = Number(match[3])
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(total) ||
      start < 0 ||
      end < start ||
      total <= end
    ) {
      throw new MalformedUpstreamError(`koios returned contradictory Content-Range for ${path}`)
    }
    return { start, end, total }
  }

  /**
   * Pack `items` into body-budget chunks, run `send` on each chunk's body concurrently, and
   * concatenate the rows. If a run fails with a 413 naming a smaller limit than we packed to, adopt
   * it, repack, and run once more. Only once: a second 413 after taking upstream's own number is a
   * problem another attempt will not fix.
   *
   * The 413 adaptation lives here so every body-budget read inherits it. batchAll sends one plain
   * batch per chunk; the address-set reads page each chunk. Both pack the same way and learn a
   * tighter cap the same way, because both hand their per-chunk work to `send`.
   */
  async function packAdaptively<Row, Item>(
    items: Item[],
    toBody: (chunk: Item[]) => unknown,
    send: (body: unknown) => Promise<Row[]>,
  ): Promise<Row[]> {
    const run = async (): Promise<Row[]> => {
      const chunks = packBySize(items, toBody, bodyLimit)
      const perChunk = await Promise.all(chunks.map((chunk) => send(toBody(chunk))))
      return perChunk.flat()
    }

    try {
      return await run()
    } catch (err) {
      const said = limitFrom413(err)
      if (said === undefined || said >= bodyLimit) throw err
      bodyLimit = said
      return run()
    }
  }

  return {
    get<T>(schema: z.ZodType<T>, path: string): Promise<T> {
      return read(path, async () => parse(schema, await request(path), path))
    },

    readWithRetry: read,

    getFirst<T>(schema: z.ZodType<T>, path: string): Promise<T> {
      return read(path, async () => {
        const rows = parse(z.array(z.unknown()), await request(path), path)
        if (rows.length === 0) {
          throw new MalformedUpstreamError(`koios returned no rows for ${path}`)
        }
        return parse(schema, rows[0], path)
      })
    },

    batch,

    async batchPageOnce<Row>(
      rowSchema: z.ZodType<Row>,
      path: string,
      body: unknown,
    ): Promise<KoiosBatchPage<Row>> {
      const response = await requestWithMetadata(path, {
        method: 'POST',
        body: JSON.stringify(body),
        contentType: 'application/json',
        headers: {
          prefer: 'count=exact',
        },
      })
      return {
        rows: parse(z.array(rowSchema), response.data, path),
        status: response.status,
        range:
          response.contentRange === null ? null : parseContentRange(response.contentRange, path),
      }
    },

    batchAllPages<Row>(
      rowSchema: z.ZodType<Row>,
      path: string,
      body: unknown,
      rowKey?: (row: Row) => string,
    ): Promise<Row[]> {
      return read(path, async () => {
        const rows: Row[] = []
        const seenKeys = new Set<string>()
        let expectedStart = 0
        let expectedTotal: number | undefined

        const appendPage = (page: Row[]): void => {
          if (rowKey !== undefined) {
            for (const row of page) {
              const key = rowKey(row)
              if (seenKeys.has(key)) {
                // Never put the key in the error. Callers use wallet identifiers as keys, and
                // upstream failures flow through normal logs.
                throw new MalformedUpstreamError(
                  `koios returned a duplicate row across pages for ${path}`,
                )
              }
              seenKeys.add(key)
            }
          }
          rows.push(...page)
        }

        for (;;) {
          const separator = path.includes('?') ? '&' : '?'
          const pagePath = `${path}${separator}limit=${KOIOS_PAGE_SIZE}&offset=${expectedStart}`
          const response = await requestWithMetadata(pagePath, {
            method: 'POST',
            body: JSON.stringify(body),
            contentType: 'application/json',
            headers: {
              prefer: 'count=exact',
            },
          })
          const page = parse(z.array(rowSchema), response.data, path)

          if (response.contentRange === null) {
            if (response.status === 206 || expectedStart !== 0) {
              throw new MalformedUpstreamError(
                `koios omitted Content-Range from a partial response for ${path}`,
              )
            }
            if (page.length >= KOIOS_PAGE_SIZE) {
              throw new MalformedUpstreamError(
                `koios returned a full page without Content-Range for ${path}`,
              )
            }
            appendPage(page)
            return rows
          }

          const range = parseContentRange(response.contentRange, path)
          if (!('start' in range)) {
            if (expectedStart !== 0 || page.length !== 0) {
              throw new MalformedUpstreamError(
                `koios returned rows for an empty Content-Range on ${path}`,
              )
            }
            return []
          }

          if (range.start !== expectedStart || page.length !== range.end - range.start + 1) {
            throw new MalformedUpstreamError(`koios returned a non-contiguous page for ${path}`)
          }
          if (expectedTotal !== undefined && range.total !== expectedTotal) {
            throw new MalformedUpstreamError(`koios changed the paged result total for ${path}`)
          }
          expectedTotal = range.total
          if (expectedTotal > KOIOS_MAX_PAGED_ROWS) {
            throw new MalformedUpstreamError(
              `koios paged result exceeds ${KOIOS_MAX_PAGED_ROWS} rows for ${path}`,
            )
          }

          appendPage(page)
          expectedStart = range.end + 1
          if (expectedStart === expectedTotal) return rows
          if (response.status !== 206) {
            throw new MalformedUpstreamError(
              `koios returned an incomplete successful response for ${path}`,
            )
          }
        }
      })
    },

    packAdaptively,

    async batchAll<Row, Item>(
      rowSchema: z.ZodType<Row>,
      path: string,
      items: Item[],
      toBody: (chunk: Item[]) => unknown,
    ): Promise<Row[]> {
      if (items.length === 0) return []
      // One plain batch per chunk. The packing and the 413 limit-learning live in packAdaptively,
      // shared with the address-set reads so a smaller upstream body cap is learned in one place.
      return packAdaptively(items, toBody, (body) => batch(z.array(rowSchema), path, body))
    },

    get bodyLimit(): number {
      return bodyLimit
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
