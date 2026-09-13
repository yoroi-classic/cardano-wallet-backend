import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { createRateLimiter } from '../../src/providers/blockfrost/rate-limiter.js'
import { ConfigError, ProviderError } from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'

const TIP_ROW = {
  time: 1_641_338_934,
  height: 15_243_593,
  hash: '4ea1ba291e8eef538635a53e59fddba7810d1679631cc3aed7c8e6c4091a516a',
  slot: 412_162_133,
  epoch: 425,
  epoch_slot: 12,
}

/**
 * A fully virtual clock: nothing waits on real time. `delay` registers a timer against the virtual
 * `now`, and `runUntil` drives the flow by draining microtasks and then advancing `now` to the
 * next scheduled timer, over and over, until the work promise settles. Tracking the work promise
 * (rather than merely "no timers left") is what keeps a long microtask chain — a 500-request burst
 * spread across the worker pool — from being mistaken for completion and left half-run. It lets a
 * test assert the exact virtual time at which each request went out.
 */
function virtualClock(): {
  clock: { now: () => number; delay: (ms: number) => Promise<void> }
  runUntil: (work: Promise<unknown>) => Promise<void>
} {
  let now = 0
  let timers: { at: number; resolve: () => void }[] = []
  const clock = {
    now: () => now,
    delay: (ms: number): Promise<void> =>
      new Promise((resolve) => {
        timers.push({ at: now + Math.max(0, ms), resolve })
      }),
  }
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 1000; i += 1) await Promise.resolve()
  }
  async function runUntil(work: Promise<unknown>): Promise<void> {
    let done = false
    // Settle-tracking only; the caller owns the real outcome, so swallow here to avoid a spurious
    // unhandled rejection.
    void Promise.resolve(work).then(
      () => {
        done = true
      },
      () => {
        done = true
      },
    )
    for (;;) {
      await flushMicrotasks()
      if (done) return
      if (timers.length === 0) return
      timers.sort((a, b) => a.at - b.at)
      const nextAt = timers[0]?.at ?? now
      now = Math.max(now, nextAt)
      const due = timers.filter((t) => t.at <= now)
      timers = timers.filter((t) => t.at > now)
      for (const t of due) t.resolve()
    }
  }
  return { clock, runUntil }
}

describe('blockfrost rate limiter', () => {
  it('paces a full-size batch to the sustained rate after the burst', async () => {
    const { clock, runUntil } = virtualClock()
    const SIZE = 1000
    const RATE = 10
    const BURST = 500
    const prefix = `${BASE}/addresses/addr_test1q`
    const addresses = Array.from({ length: SIZE }, (_, i) => `addr_test1q${i}`)
    // The virtual time each request went out at.
    const times: number[] = []

    const fetchImpl: FetchLike = async (url) => {
      times.push(clock.now())
      const index = Number(url.slice(prefix.length))
      return {
        ok: true,
        status: 200,
        json: async () => ({ address: addresses[index] }),
        text: async () => '',
      }
    }
    const provider = createBlockfrostProvider({
      baseUrl: BASE,
      projectId: PROJECT_ID,
      fetchImpl,
      requestsPerSecond: RATE,
      burstSize: BURST,
      nowImpl: clock.now,
      delayImpl: clock.delay,
    })

    const pending = provider.filterUsedAddresses(addresses)
    await runUntil(pending)
    const result = await pending

    expect(result).toHaveLength(SIZE)
    expect(times).toHaveLength(SIZE)

    // The burst bucket is spent immediately, all at virtual time 0.
    expect(times.filter((t) => t === 0)).toHaveLength(BURST)

    // Past the burst, the sustained rate holds: no one-second window carries more than the rate
    // (plus one for the window boundary). This is the property a bare concurrency cap fails.
    const maxT = Math.max(...times)
    for (let start = 1; start + 1000 <= maxT + 1; start += 100) {
      const inWindow = times.filter((t) => t >= start && t < start + 1000).length
      expect(inWindow).toBeLessThanOrEqual(RATE + 1)
    }

    // And the tail really is paced, not dumped: 500 requests past the burst at 10/s is ~50s.
    expect(maxT).toBeGreaterThanOrEqual(((SIZE - BURST) / RATE) * 1000 * 0.95)
  })

  it('retries a 429 honoring Retry-After and then succeeds', async () => {
    const { clock, runUntil } = virtualClock()
    const waits: number[] = []
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({}),
          text: async () => 'slow down',
          headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '2' : null) },
        }
      }
      return { ok: true, status: 200, json: async () => TIP_ROW, text: async () => '' }
    }
    const provider = createBlockfrostProvider({
      baseUrl: BASE,
      projectId: PROJECT_ID,
      fetchImpl,
      nowImpl: clock.now,
      delayImpl: async (ms) => {
        waits.push(ms)
        return clock.delay(ms)
      },
    })

    const pending = provider.getTip()
    await runUntil(pending)
    const tip = await pending

    expect(calls).toBe(2)
    expect(tip.block).toBe(TIP_ROW.height)
    // The two-second Retry-After was honored (2000ms), not the default backoff.
    expect(waits).toContain(2000)
  })

  it('gives up on a persistent 429 after a bounded number of retries', async () => {
    const { clock, runUntil } = virtualClock()
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return {
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => '',
        headers: { get: () => '1' },
      }
    }
    const provider = createBlockfrostProvider({
      baseUrl: BASE,
      projectId: PROJECT_ID,
      fetchImpl,
      nowImpl: clock.now,
      delayImpl: clock.delay,
      rateLimitRetries: 3,
    })

    // Capture the outcome without leaving an unhandled rejection while the clock drives the flow.
    const settled = provider.getTip().then(
      () => 'resolved',
      (err: unknown) => err,
    )
    await runUntil(settled)
    const outcome = await settled

    expect(outcome).toBeInstanceOf(ProviderError)
    // One initial attempt plus three retries, then the 429 surfaces rather than looping forever.
    expect(calls).toBe(4)
  })

  it('does not retry a 429 on submit, because a write must never be replayed', async () => {
    const { clock, runUntil } = virtualClock()
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return {
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => '',
        headers: { get: () => '1' },
      }
    }
    const provider = createBlockfrostProvider({
      baseUrl: BASE,
      projectId: PROJECT_ID,
      fetchImpl,
      nowImpl: clock.now,
      delayImpl: clock.delay,
    })

    const settled = provider.submitTx('0102').then(
      () => 'resolved',
      (err: unknown) => err,
    )
    await runUntil(settled)
    const outcome = await settled

    expect(outcome).toBeInstanceOf(ProviderError)
    expect(calls).toBe(1)
  })

  it('surfaces a 429 whose Retry-After exceeds the local wait cap instead of retrying early', async () => {
    const { clock, runUntil } = virtualClock()
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return {
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => 'come back much later',
        // 120s, well past the 30s local cap: waiting only the cap would hit the server before it
        // said it was safe, so this must surface rather than retry.
        headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '120' : null) },
      }
    }
    const provider = createBlockfrostProvider({
      baseUrl: BASE,
      projectId: PROJECT_ID,
      fetchImpl,
      nowImpl: clock.now,
      delayImpl: clock.delay,
    })

    const settled = provider.getTip().then(
      () => 'resolved',
      (err: unknown) => err,
    )
    await runUntil(settled)
    const outcome = await settled

    expect(outcome).toBeInstanceOf(ProviderError)
    expect((outcome as ProviderError).upstreamStatus).toBe(429)
    // No retry: the one call was made, the over-cap Retry-After was respected by giving up.
    expect(calls).toBe(1)
  })

  it('still retries when Retry-After is exactly at the wait cap', async () => {
    const { clock, runUntil } = virtualClock()
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({}),
          text: async () => 'slow down',
          // 30s == the cap, not over it, so this is honored and retried, not surfaced.
          headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '30' : null) },
        }
      }
      return { ok: true, status: 200, json: async () => TIP_ROW, text: async () => '' }
    }
    const provider = createBlockfrostProvider({
      baseUrl: BASE,
      projectId: PROJECT_ID,
      fetchImpl,
      nowImpl: clock.now,
      delayImpl: clock.delay,
    })

    const pending = provider.getTip()
    await runUntil(pending)
    const tip = await pending

    expect(tip.block).toBe(TIP_ROW.height)
    expect(calls).toBe(2)
  })
})

describe('blockfrost client config validation', () => {
  const MAX_TIMER_MS = 2_147_483_647
  const MAX_RETRIES = 100
  const MAX_BURST = 100_000
  const MIN_RPS = 1e-3
  const MAX_RPS = 1_000_000
  // 2**53 is a whole number Number.isInteger accepts but Number.isSafeInteger rejects: past it,
  // integers stop incrementing, so it is exactly the class of "integer" that must not slip through.
  const UNSAFE_INT = 2 ** 53

  it.each([
    // Integer count knobs: every failure mode, including the two the earlier validator let through
    // (an unsafe integer, and a value past the sane maximum).
    ['rateLimitRetries negative', { rateLimitRetries: -1 }],
    ['rateLimitRetries fractional', { rateLimitRetries: 1.5 }],
    ['rateLimitRetries NaN', { rateLimitRetries: Number.NaN }],
    ['rateLimitRetries Infinity', { rateLimitRetries: Number.POSITIVE_INFINITY }],
    ['rateLimitRetries unsafe integer', { rateLimitRetries: UNSAFE_INT }],
    ['rateLimitRetries over max', { rateLimitRetries: MAX_RETRIES + 1 }],
    ['readAttempts zero', { readAttempts: 0 }],
    ['readAttempts NaN', { readAttempts: Number.NaN }],
    ['readAttempts unsafe integer', { readAttempts: UNSAFE_INT }],
    ['readAttempts over max', { readAttempts: MAX_RETRIES + 1 }],
    ['burstSize zero', { burstSize: 0 }],
    ['burstSize fractional', { burstSize: 2.5 }],
    ['burstSize unsafe integer', { burstSize: UNSAFE_INT }],
    ['burstSize over max', { burstSize: MAX_BURST + 1 }],
    // Duration knobs: non-finite, below floor, above the timer range, and fractional (a timer
    // requires an integer ms delay, so 100.5 would fail every request).
    ['timeoutMs negative', { timeoutMs: -5 }],
    ['timeoutMs zero (floor is 1)', { timeoutMs: 0 }],
    ['timeoutMs Infinity', { timeoutMs: Number.POSITIVE_INFINITY }],
    ['timeoutMs NaN', { timeoutMs: Number.NaN }],
    ['timeoutMs over the timer range', { timeoutMs: MAX_TIMER_MS + 1 }],
    ['timeoutMs fractional', { timeoutMs: 100.5 }],
    ['retryBackoffMs negative', { retryBackoffMs: -1 }],
    ['retryBackoffMs Infinity', { retryBackoffMs: Number.POSITIVE_INFINITY }],
    ['retryBackoffMs over the timer range', { retryBackoffMs: MAX_TIMER_MS + 1 }],
    ['retryBackoffMs fractional', { retryBackoffMs: 150.25 }],
    // Rate knob: zero, subnormal, Infinity, and past the max.
    ['requestsPerSecond zero', { requestsPerSecond: 0 }],
    ['requestsPerSecond subnormal', { requestsPerSecond: Number.MIN_VALUE }],
    ['requestsPerSecond NaN', { requestsPerSecond: Number.NaN }],
    ['requestsPerSecond Infinity', { requestsPerSecond: Number.POSITIVE_INFINITY }],
    ['requestsPerSecond over max', { requestsPerSecond: MAX_RPS + 1 }],
  ])('rejects a malformed %s at construction', (_name, overrides) => {
    expect(() =>
      createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, ...overrides }),
    ).toThrow(ConfigError)
  })

  it.each([
    ['rateLimitRetries floor', { rateLimitRetries: 0 }],
    ['rateLimitRetries max', { rateLimitRetries: MAX_RETRIES }],
    ['readAttempts floor', { readAttempts: 1 }],
    ['readAttempts max', { readAttempts: MAX_RETRIES }],
    ['burstSize floor', { burstSize: 1 }],
    ['burstSize max', { burstSize: MAX_BURST }],
    ['timeoutMs floor', { timeoutMs: 1 }],
    ['timeoutMs integer', { timeoutMs: 100 }],
    ['timeoutMs at the timer range', { timeoutMs: MAX_TIMER_MS }],
    ['retryBackoffMs floor', { retryBackoffMs: 0 }],
    ['retryBackoffMs integer', { retryBackoffMs: 150 }],
    ['retryBackoffMs at the timer range', { retryBackoffMs: MAX_TIMER_MS }],
    ['requestsPerSecond floor', { requestsPerSecond: MIN_RPS }],
    ['requestsPerSecond max', { requestsPerSecond: MAX_RPS }],
    ['requestsPerSecond typical', { requestsPerSecond: 10 }],
  ])('accepts an in-range %s', (_name, overrides) => {
    expect(() =>
      createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, ...overrides }),
    ).not.toThrow()
  })
})

describe('blockfrost rate limiter — burst ceiling across a pause', () => {
  it('caps the post-pause release at the burst, not one grant per elapsed interval', async () => {
    // A hand-driven clock so the test can jump time forward the way a process pause or a late timer
    // would, then fire everything that came due at once.
    let now = 0
    let pending: { at: number; resolve: () => void }[] = []
    const clock = {
      now: () => now,
      delay: (ms: number): Promise<void> =>
        new Promise((resolve) => {
          pending.push({ at: now + Math.max(0, ms), resolve })
        }),
    }
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 500; i += 1) await Promise.resolve()
    }

    const RATE = 10
    const BURST = 5
    const limiter = createRateLimiter(RATE, BURST, clock)

    // The virtual time each acquire cleared at.
    const grantTimes: number[] = []
    const TOTAL = 20
    for (let i = 0; i < TOTAL; i += 1) {
      void limiter.acquire().then(() => {
        grantTimes.push(now)
      })
    }
    await flush()

    // The initial burst clears immediately; the rest are queued on delays.
    expect(grantTimes.filter((t) => t === 0)).toHaveLength(BURST)

    // Jump far past many refill intervals (100s is 1000 intervals here) and release every timer
    // that is now due, exactly as the event loop would after a long sleep.
    now = 100_000
    const due = pending
    pending = []
    for (const t of due) t.resolve()
    await flush()

    // The refill is capped at BURST, so only a full bucket clears at this instant — not all 15 that
    // were waiting, and not the ~1000 intervals' worth that elapsed.
    expect(grantTimes.filter((t) => t === 100_000)).toHaveLength(BURST)
    // The remainder is still parked, waiting for the bucket to refill again.
    expect(grantTimes).toHaveLength(BURST + BURST)
  })
})
