/**
 * A small in-process cache with request coalescing.
 *
 * ## Why this exists
 *
 * Chain data is not per-user. The stake pool ranking, the protocol parameters, the DRep list, a
 * token's registry metadata: every wallet asking gets the identical answer, and most of it moves
 * slowly or on a fixed schedule. Serving all of it from upstream on every request means our load
 * on Koios scales linearly with our users, on data that does not vary between them.
 *
 * ## The rule that must not be broken
 *
 * **Account-scoped reads are never cached.** Account state, UTxOs, transaction history, and
 * transaction status are per-user and must be fresh. Serving a stale balance or a stale UTxO set
 * to a wallet that is about to build a transaction produces a failed submission or a
 * double-spend. There is no TTL short enough to make that a good trade, so the account module
 * does not take a cache at all rather than taking one and being trusted not to use it.
 *
 * ## Epoch-keying is a key, not a mode
 *
 * Some values are not "fresh for N seconds", they are "fixed until the epoch changes".
 * `active_stake` is the snapshot the ledger uses for rewards, so the pool ranking derived from it
 * is stable for five days at a time and then moves all at once.
 *
 * That needs no second mechanism. Put the epoch number in the key and the entry is valid exactly
 * as long as the epoch is: at the boundary the key changes, the lookup misses, and the value is
 * recomputed. A long TTL would get precisely that moment wrong, which is the only moment that
 * matters. The TTL on such an entry is then just a memory bound, not a freshness policy.
 *
 * ## Not Redis
 *
 * One process, one Map. A shared store becomes necessary the moment we run more than one
 * instance *and* the cost of a cold miss matters, and that is a deployment decision rather than
 * an API one. The interface is what the rest of the code depends on, so swapping the
 * implementation later does not reach beyond this directory.
 */
export interface CachePolicy {
  /** How long the value is served without going back upstream. */
  ttlMs: number
  /**
   * How long past expiry a value may still be served **if a refresh fails**. 0 (the default)
   * means a failed refresh fails the request.
   *
   * This is not a longer TTL, and the difference is the whole point. Inside `ttlMs` the value is
   * served without asking upstream at all. Past it, upstream *is* asked, and only if that ask
   * *fails* does the old value get served rather than the error.
   *
   * It is what turns an upstream wobble into slightly-old data instead of a 504. Koios on mainnet
   * answers `/pool_info` in about 7 seconds most of the time and in 20 to 50 seconds the rest of
   * the time, which means a quarter of pool-list requests currently fail outright. A stake-pool
   * saturation figure that is two minutes old is worth immeasurably more to the person choosing a
   * pool than an error page is.
   *
   * **Never set this on an account-scoped read.** A stale balance or a stale UTxO set handed to a
   * wallet that is about to build a transaction is how you produce a failed submission or a
   * double-spend, and "upstream was down" is not a licence to guess at someone's money.
   */
  staleIfErrorMs?: number
}

export interface Cache {
  /**
   * The cached value for `key`, or the result of `load()` if there isn't a live one.
   *
   * Concurrent misses on the same key collapse into a single `load()`. Without that, a cold
   * cache plus a burst of wallets means N identical full pool-list walks against Koios at once:
   * exactly the load spike this is meant to prevent, arriving at the worst possible moment.
   *
   * A failing `load()` is never cached. A 502 from a wobbling provider must not be served to
   * everyone for the next five minutes. Callers already waiting on that same load do all see the
   * failure (they are the same attempt), but the next caller gets a fresh one.
   *
   * The exception is `staleIfErrorMs`: see CachePolicy. A failed refresh still is not *cached*,
   * it just does not destroy the value we already had.
   *
   * `policy` may be a plain TTL in milliseconds, which is the common case.
   */
  read<T>(key: string, policy: number | CachePolicy, load: () => Promise<T>): Promise<T>

  /** Live entries. For tests and diagnostics. */
  readonly size: number

  /** Drop everything. For tests. */
  clear(): void
}

export interface MemoryCacheOptions {
  /** Injectable clock, so tests can expire an entry without sleeping. */
  now?: () => number
  /**
   * Hard bound on live entries, so a per-subject key space (token metadata, say) cannot grow
   * without limit. Eviction drops expired entries first, then the oldest inserted.
   */
  maxEntries?: number
}

interface Entry {
  value: unknown
  expiresAt: number
  /** Past this, the value is not even good enough to serve when a refresh fails. */
  usableUntil: number
}

const DEFAULT_MAX_ENTRIES = 5_000

const asPolicy = (policy: number | CachePolicy): CachePolicy =>
  typeof policy === 'number' ? { ttlMs: policy } : policy

export function createMemoryCache(options: MemoryCacheOptions = {}): Cache {
  const now = options.now ?? Date.now
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES

  const entries = new Map<string, Entry>()
  const inFlight = new Map<string, Promise<unknown>>()

  function evict(): void {
    if (entries.size <= maxEntries) return

    // Entries nobody could use even as a fallback are free to drop, so take those first.
    const cutoff = now()
    for (const [key, entry] of entries) {
      if (entry.usableUntil <= cutoff) entries.delete(key)
    }

    // Still over: drop the oldest inserted. A Map iterates in insertion order, so the first key
    // is the oldest. This is not an LRU, and it does not need to be: the bound exists to stop
    // unbounded growth, not to optimise a hit rate.
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      entries.delete(oldest.value)
    }
  }

  return {
    read<T>(key: string, policy: number | CachePolicy, load: () => Promise<T>): Promise<T> {
      const { ttlMs, staleIfErrorMs = 0 } = asPolicy(policy)

      const hit = entries.get(key)
      if (hit !== undefined && hit.expiresAt > now()) return Promise.resolve(hit.value as T)

      // Someone else is already loading this exact key. Wait on their attempt rather than
      // starting a second identical one.
      const pending = inFlight.get(key)
      if (pending !== undefined) return pending as Promise<T>

      const attempt = (async (): Promise<T> => {
        try {
          const value = await load()
          entries.set(key, {
            value,
            expiresAt: now() + ttlMs,
            usableUntil: now() + ttlMs + staleIfErrorMs,
          })
          evict()
          return value
        } catch (err) {
          // The refresh failed. If we still hold a value that is old but not *too* old, serve it
          // rather than the error. See CachePolicy.staleIfErrorMs: for chain-wide data a
          // two-minute-old answer beats a 504, and for account data there is no such thing as an
          // acceptable guess, which is why staleIfErrorMs defaults to 0 and account reads never
          // set it.
          //
          // Note what is *not* happening: the failure is not cached, and the entry's deadlines are
          // not extended. The next caller tries upstream again, and once the value ages past
          // usableUntil it stops being served at all, so a long outage surfaces as an error rather
          // than as data from last week.
          const stale = entries.get(key)
          if (stale !== undefined && stale.usableUntil > now()) return stale.value as T
          throw err
        } finally {
          inFlight.delete(key)
        }
      })()

      inFlight.set(key, attempt)
      return attempt
    },

    get size(): number {
      return entries.size
    },

    clear(): void {
      entries.clear()
      inFlight.clear()
    },
  }
}

/**
 * A cache that caches nothing: every read goes straight to `load()`.
 *
 * This is the default a provider gets when none is injected, so a unit test exercises the real
 * upstream path and its call counts mean what they look like. Production wires a real cache in
 * the provider factory.
 */
export const noCache: Cache = {
  read<T>(_key: string, _policy: number | CachePolicy, load: () => Promise<T>): Promise<T> {
    return load()
  },
  size: 0,
  clear(): void {},
}
