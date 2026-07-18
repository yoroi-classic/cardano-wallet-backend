/** The clock a rate limiter reads and waits on, injectable so tests drive it without real timers. */
export interface RateLimiterClock {
  /** Current time in milliseconds. */
  now: () => number
  /** Resolve after roughly `ms` have passed on this clock. */
  delay: (ms: number) => Promise<void>
}

export interface RateLimiter {
  /** Resolve once this caller is cleared to make one request, waiting if the budget is spent. */
  acquire: () => Promise<void>
}

/**
 * A request-rate governor, not merely a concurrency cap.
 *
 * A concurrency ceiling bounds how many requests are *in flight* at once, but with fast responses
 * even a small ceiling sustains a request rate far above what an upstream allows. Blockfrost meters
 * the actual rate: ~10 requests/second sustained, with a 500-slot burst bucket that refills at
 * 10/s, and a 429 once that is drained. A large filter-used batch run only under a concurrency cap
 * would empty the burst in a moment and then 429 its tail. This paces the average rate instead, so
 * one shared budget covers every overlapping request.
 *
 * Implemented as a token bucket: `burst` tokens to start, refilled at `requestsPerSecond`, one
 * spent per grant. The refill is *capped at `burst`*, and every waiter re-checks the live bucket
 * each time it wakes rather than trusting a wait computed before it slept. That combination is what
 * holds the burst ceiling across a long process pause or a timer that fires late: however much time
 * passed while requests were queued, at most a full bucket is released the instant they wake, not
 * one grant per elapsed interval all at once.
 *
 * The refill/check/spend step is synchronous and runs to completion before any await, so concurrent
 * callers cannot both claim the same token and there is no lock and no race on the single JS thread.
 */
export function createRateLimiter(
  requestsPerSecond: number,
  burst: number,
  clock: RateLimiterClock,
): RateLimiter {
  // Tokens gained per millisecond; one token is spent per granted request.
  const refillPerMs = requestsPerSecond / 1000
  // Start full so the first `burst` requests go out back-to-back.
  let tokens = burst
  let last = clock.now()

  function refill(): void {
    const now = clock.now()
    const elapsed = now - last
    if (elapsed <= 0) return
    // Cap at `burst`: no matter how long the pause, the bucket never holds more than one burst's
    // worth, so the queue cannot drain more than that in a single instant when it wakes.
    tokens = Math.min(burst, tokens + elapsed * refillPerMs)
    last = now
  }

  return {
    async acquire(): Promise<void> {
      for (;;) {
        refill()
        if (tokens >= 1) {
          tokens -= 1
          return
        }
        // Not enough in the bucket yet: wait roughly long enough to refill the shortfall, then
        // loop and re-check against the live budget. `Math.max(1, ...)` guarantees forward
        // progress rather than a zero-length spin.
        const waitMs = Math.max(1, Math.ceil((1 - tokens) / refillPerMs))
        await clock.delay(waitMs)
      }
    },
  }
}
