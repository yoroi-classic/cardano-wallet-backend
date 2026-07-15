import type { Cache } from '../cache/index.js'
import { MalformedUpstreamError, ProviderError, ProviderTimeoutError } from '../domain/errors.js'

/**
 * Remote configuration: feature flags, the dApp list, and whatever else the clients decide to
 * read at launch.
 *
 * ## Why this is served by us at all
 *
 * The clients fetch this from a JSON file in a git repository. That is fine as a *source* and
 * wrong as a *dependency*, for three reasons that have nothing to do with each other:
 *
 *   - **Trust.** Whoever controls the file controls what our users see. While that file lived in
 *     Emurgo's repository, they could push a banner into our wallet, or point our dApp list
 *     somewhere, or simply delete it, and every install would follow. Ours now lives in
 *     yoroi-classic. This endpoint is what makes "ours" mean something, because the client asks
 *     *us*, not a host we do not control.
 *
 *   - **Privacy.** A client fetching raw.githubusercontent.com on every launch hands its IP to
 *     GitHub on every launch. We already refuse to write that down ourselves (see
 *     src/http/logging.ts); it would be an odd principle that stopped at our own log file and let
 *     a third party keep the same record. Fetching it here means the wallet talks to one host.
 *
 *   - **Availability.** A wallet that cannot start because a CDN is having a bad morning is a bad
 *     wallet. See the caching below: config is the one thing here that should essentially never
 *     fail.
 *
 * ## What is deliberately *not* here
 *
 * No transformation. We serve the document as published and do not editorialise it, because the
 * moment this endpoint starts rewriting config it becomes a second place to look when the client
 * misbehaves, and nobody remembers to look in two places.
 *
 * The de-Emurgo-ing already happened where it belongs: in the fork. Every banner in the published
 * config is `display: false`, the house DRep is off, and the promoted pool is empty. That is a
 * content decision and it lives in content.
 */

/** How long a fetched config is served before we ask again. */
const TTL_MS = 5 * 60_000

/**
 * How long a config may still be served after a refresh has failed.
 *
 * Long, and deliberately so. This is the one read in the service where a stale answer is almost
 * always better than an error: the values change rarely, a day-old feature flag is very unlikely
 * to be wrong, and the alternative is a wallet that will not finish starting because GitHub is
 * having a bad morning.
 *
 * Contrast with an account balance, where there is no such thing as an acceptable stale value.
 * The difference is not the mechanism, it is what the number *is*.
 */
const STALE_IF_ERROR_MS = 24 * 60 * 60_000

/** Our own fork. Not Emurgo's, and that is the entire point of the fork. */
export const DEFAULT_CONFIG_URL =
  'https://raw.githubusercontent.com/yoroi-classic/yoroi-config/refs/heads/main/prod.json'

const TIMEOUT_MS = 10_000

/** A minimal fetch signature, so tests inject a fake without pulling in DOM types. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

const CACHE_KEY = 'config:remote'

export interface RemoteConfigOptions {
  /** Where the config is published. Defaults to our fork. */
  url?: string
  /** Shared cache. Without one, every client launch would refetch. */
  cache?: Cache
  fetchImpl?: FetchLike
  /** Injectable clock, so a test can age a config out without sleeping. */
  now?: () => number
}

export interface RemoteConfig {
  /** The published config document, as-is. */
  get(): Promise<unknown>
  /** Where it came from, so `/v1/status` and an operator can both see it. */
  readonly source: string
}

export function createRemoteConfig(options: RemoteConfigOptions = {}): RemoteConfig {
  const url = options.url ?? DEFAULT_CONFIG_URL
  const cache = options.cache
  const doFetch: FetchLike = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const now = options.now ?? Date.now

  async function load(): Promise<unknown> {
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await doFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ProviderTimeoutError('remote config timed out', cause)
      }
      throw new ProviderError('remote config could not be fetched', { cause })
    }

    if (!res.ok) {
      throw new ProviderError(`remote config returned ${res.status}`, {
        upstreamStatus: res.status,
      })
    }

    let body: unknown
    try {
      body = await res.json()
    } catch (cause) {
      throw new MalformedUpstreamError('remote config is not valid json', cause)
    }

    // A shape check, not a schema. The document's contents belong to the clients and will change
    // without us, so validating its fields here would make this service a thing that has to be
    // redeployed whenever a flag is added, which defeats the purpose of remote config entirely.
    //
    // But it must be an object. An array, a string, or a `null` is not a config, and serving one
    // would push a crash into a wallet's launch path, which is the single worst place to put one.
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new MalformedUpstreamError('remote config is not a json object')
    }

    return body
  }

  /**
   * The last config we successfully fetched, and when.
   *
   * Held here rather than leaning on a cache feature, for two reasons. It keeps this module's
   * resilience its own business, so a config endpoint does not quietly become fragile because
   * somebody changed a cache policy elsewhere. And it survives `CACHE_ENABLED=false`, which is
   * exactly the setting an operator reaches for while debugging upstream, and exactly the moment
   * they would least like the wallets to stop starting.
   */
  let lastGood: { value: unknown; at: number } | undefined

  async function fetchAndRemember(): Promise<unknown> {
    const value = await load()
    lastGood = { value, at: now() }
    return value
  }

  return {
    source: url,

    async get(): Promise<unknown> {
      try {
        return cache === undefined
          ? await fetchAndRemember()
          : await cache.read(CACHE_KEY, TTL_MS, fetchAndRemember)
      } catch (err) {
        // The fetch failed. If we have a config that is old but not *ancient*, serve it: a wallet
        // that cannot finish starting because a git host is having a bad morning is a bad wallet,
        // and a day-old feature flag is very unlikely to be wrong.
        //
        // Note what does not happen: the timestamp is not refreshed on failure, so a long outage
        // eventually surfaces as an error rather than serving last month's config forever. And if
        // we never had one, the error stands: inventing a config would be far worse than failing,
        // because a client would act on it.
        if (lastGood !== undefined && now() - lastGood.at < STALE_IF_ERROR_MS) {
          return lastGood.value
        }
        throw err
      }
    },
  }
}
