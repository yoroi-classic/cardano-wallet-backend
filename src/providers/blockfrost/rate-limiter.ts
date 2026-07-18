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
 * Implemented as GCRA (a leaky-bucket variant): a single `tat` (theoretical arrival time) marches
 * forward by one emission interval per grant, and `burst` sets how far ahead of the clock a run of
 * grants may get before pacing engages. The reservation is computed and stored synchronously,
 * before any await, so concurrent callers each claim a distinct, correctly spaced slot with no
 * lock and no race on the single JS thread.
 */
export function createRateLimiter(
  requestsPerSecond: number,
  burst: number,
  clock: RateLimiterClock,
): RateLimiter {
  // Milliseconds between sustained grants.
  const interval = 1000 / requestsPerSecond
  // How far ahead of "now" a burst of grants is allowed to reserve before a wait is imposed.
  const tolerance = Math.max(0, burst - 1) * interval
  // Theoretical arrival time of the next grant; starts in the past so the first burst is free.
  let tat = clock.now()

  return {
    async acquire(): Promise<void> {
      const now = clock.now()
      const grantAt = Math.max(tat, now)
      // Reserve this slot before awaiting anything, so an overlapping caller cannot claim it too.
      tat = grantAt + interval
      const waitMs = grantAt - tolerance - now
      if (waitMs > 0) await clock.delay(waitMs)
    },
  }
}
