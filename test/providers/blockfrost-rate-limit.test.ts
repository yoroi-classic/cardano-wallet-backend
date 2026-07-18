import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { ProviderError } from '../../src/domain/errors.js'

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
})
