import { describe, expect, it } from 'vitest'
import { createTokenBucket } from '../../src/prices/rate-limit.js'

/**
 * A clock and a wait the test controls directly: `delay(ms)` registers a waiter that only resolves
 * once the test advances its clock past it, so pacing is exercised with no real time passing.
 */
function manualClock() {
  let current = 0
  const waiters: Array<{ at: number; resolve: () => void }> = []
  // A macrotask boundary that drains the whole microtask queue, so every continuation a released
  // waiter unblocks has run before the next step.
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  return {
    now: () => current,
    delay: (ms: number): Promise<void> =>
      ms <= 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ at: current + ms, resolve })
          }),
    async advanceTo(target: number): Promise<void> {
      for (;;) {
        await flush()
        let idx = -1
        for (let i = 0; i < waiters.length; i++) {
          if (waiters[i]!.at <= target && (idx === -1 || waiters[i]!.at < waiters[idx]!.at)) {
            idx = i
          }
        }
        if (idx === -1) break
        const [next] = waiters.splice(idx, 1)
        current = Math.max(current, next!.at)
        next!.resolve()
      }
      current = target
    },
  }
}

// The production settings from geckoterminal.ts: a small burst, then a sustained pace under the
// 30-calls-per-minute GeckoTerminal free-tier limit.
const BURST = 4
const INTERVAL_MS = 2_500

describe('token bucket', () => {
  it('bursts up to capacity, then paces the rest at the configured interval', async () => {
    const clock = manualClock()
    const bucket = createTokenBucket({
      capacity: BURST,
      refillIntervalMs: INTERVAL_MS,
      now: clock.now,
      delay: clock.delay,
    })
    const emitTimes: number[] = []

    const done = Promise.all(
      Array.from({ length: 40 }, async () => {
        await bucket.acquire()
        emitTimes.push(clock.now())
      }),
    )
    await clock.advanceTo(10 * 60_000)
    await done

    expect(emitTimes).toHaveLength(40)
    const sorted = [...emitTimes].sort((a, b) => a - b)

    // The burst goes out at once, and every call after it is at least one interval on from the one
    // `capacity` places before it: the core budget invariant.
    expect(sorted.filter((t) => t === 0)).toHaveLength(BURST)
    for (let i = 0; i + BURST < sorted.length; i++) {
      expect(sorted[i + BURST]! - sorted[i]!).toBeGreaterThanOrEqual(INTERVAL_MS)
    }
  })

  it('never lets a 60-second window exceed the 30-call GeckoTerminal limit', async () => {
    const clock = manualClock()
    const bucket = createTokenBucket({
      capacity: BURST,
      refillIntervalMs: INTERVAL_MS,
      now: clock.now,
      delay: clock.delay,
    })
    const emitTimes: number[] = []

    const done = Promise.all(
      Array.from({ length: 60 }, async () => {
        await bucket.acquire()
        emitTimes.push(clock.now())
      }),
    )
    await clock.advanceTo(10 * 60_000)
    await done

    const busiestMinute = Math.max(
      ...emitTimes.map((t) => emitTimes.filter((u) => u >= t && u < t + 60_000).length),
    )
    expect(busiestMinute).toBeLessThanOrEqual(30)
  })

  it('shares one budget across callers, since the bucket is a single instance', async () => {
    // Two independent streams of acquisitions on the same bucket, as two concurrent HTTP requests
    // would be: the burst is still 4 total, not 4 each, because they draw from one bucket.
    const clock = manualClock()
    const bucket = createTokenBucket({
      capacity: BURST,
      refillIntervalMs: INTERVAL_MS,
      now: clock.now,
      delay: clock.delay,
    })
    const emitTimes: number[] = []
    const stream = () =>
      Array.from({ length: 10 }, async () => {
        await bucket.acquire()
        emitTimes.push(clock.now())
      })

    const done = Promise.all([...stream(), ...stream()])
    await clock.advanceTo(10 * 60_000)
    await done

    expect(emitTimes.filter((t) => t === 0)).toHaveLength(BURST)
  })
})
