import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../../src/providers/blockfrost/concurrency.js'

describe('mapWithConcurrency', () => {
  it('maps in input order regardless of completion order', async () => {
    const out = await mapWithConcurrency([10, 5, 1], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms))
      return i
    })

    expect(out).toEqual([0, 1, 2])
  })

  it('never runs more than the limit at once', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(
      Array.from({ length: 50 }, (_, i) => i),
      4,
      async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 0))
        inFlight -= 1
      },
    )

    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('rejects with the first worker error and stops claiming new items after a failure', async () => {
    const started: number[] = []
    // With a single worker, item 0 fails immediately; no later item should ever be claimed.
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4], 1, async (item) => {
        started.push(item)
        if (item === 0) throw new Error('boom')
        return item
      }),
    ).rejects.toThrow('boom')

    expect(started).toEqual([0])
  })

  it('lets in-flight peers finish but claims nothing new once one has failed', async () => {
    const claimed: number[] = []
    // Two workers over six items. The first item rejects almost immediately; its peer is mid-flight
    // and completes, but neither worker claims any of the remaining queued items.
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
        claimed.push(item)
        if (item === 0) {
          await new Promise((r) => setTimeout(r, 1))
          throw new Error('boom')
        }
        await new Promise((r) => setTimeout(r, 5))
        return item
      }),
    ).rejects.toThrow('boom')

    // Items 0 and 1 were claimed at the start; the queue (2..5) is abandoned after the failure.
    expect(claimed).toEqual([0, 1])
  })
})
