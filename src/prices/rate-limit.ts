/**
 * A small in-process token bucket, so every call to a rate-limited upstream is spaced within a
 * fixed budget no matter how many arrive at once.
 *
 * ## Why this exists
 *
 * GeckoTerminal's keyless tier is a low, shared, per-IP budget. Limiting *concurrency* alone does
 * not protect it: eight in-flight calls that each return in a few milliseconds still emit far more
 * than the per-minute quota over a burst, so a single cold batch of a hundred subjects can trip a
 * 429 that fails the whole response. A token bucket bounds the *rate* rather than the fan-out, and
 * one bucket shared across every concurrent request bounds the rate across all of them together,
 * which is the only budget the upstream actually enforces.
 *
 * ## The algorithm
 *
 * A slot is reserved synchronously (so concurrent callers can never claim the same one), and only
 * the wait until that slot's release is asynchronous. Up to `capacity` calls may go out
 * back-to-back; after that they are paced one per `refillIntervalMs`. This is the standard
 * "theoretical arrival time" formulation, which needs a single number of state and handles any
 * number of overlapping callers without a queue.
 */
export interface TokenBucket {
  /** Resolve once this caller is cleared to make one upstream call, respecting the budget. */
  acquire(): Promise<void>
}

export interface TokenBucketOptions {
  /** How many calls may go out back-to-back before pacing kicks in. */
  capacity: number
  /** Sustained pace once the burst is spent: one call per this many milliseconds. */
  refillIntervalMs: number
  /** Injectable clock, so tests can pace the bucket without real time passing. */
  now?: () => number
  /** Injectable wait, so tests can release a paced call by advancing their own clock. */
  delay?: (ms: number) => Promise<void>
}

const realDelay = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const { capacity, refillIntervalMs } = options
  const now = options.now ?? Date.now
  const delay = options.delay ?? realDelay

  // The tolerance that lets `capacity` calls precede their paced emission time before any waiting
  // is required, i.e. the burst.
  const burst = (capacity - 1) * refillIntervalMs

  // The emission time already handed out to the most recent caller. Starts in the present, so a
  // cold bucket grants its first `capacity` calls immediately.
  let theoreticalArrival = now()

  return {
    acquire(): Promise<void> {
      const t = now()
      // This caller's emission slot: the later of "now" and the next free slot in the pace.
      const emitAt = Math.max(theoreticalArrival, t)
      // Reserve it synchronously before any await, so overlapping callers each get a distinct one.
      theoreticalArrival = emitAt + refillIntervalMs
      // It may actually go out `burst` earlier than its emission slot; that is what the burst is.
      const waitMs = emitAt - burst - t
      return delay(waitMs)
    },
  }
}
