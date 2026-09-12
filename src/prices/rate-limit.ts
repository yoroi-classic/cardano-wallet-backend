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
 * The bucket starts with `capacity` tokens and refills one token per `refillIntervalMs`, capped at
 * capacity. Every caller synchronously checks and spends the live balance; when empty, it waits
 * only until the next token should exist and then checks again. Rechecking after every wait matters
 * when the event loop stalls: many expired timers may wake together, but only a full bucket can be
 * spent at that instant, rather than every old timer becoming a permanent grant.
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

  const refillPerMs = 1 / refillIntervalMs
  let tokens = capacity
  let lastRefill = now()

  function refill(): void {
    const current = now()
    const elapsed = current - lastRefill
    if (elapsed <= 0) return
    tokens = Math.min(capacity, tokens + elapsed * refillPerMs)
    lastRefill = current
  }

  return {
    async acquire(): Promise<void> {
      for (;;) {
        refill()
        if (tokens >= 1) {
          tokens -= 1
          return
        }
        const waitMs = Math.max(1, Math.ceil((1 - tokens) / refillPerMs))
        await delay(waitMs)
      }
    },
  }
}
