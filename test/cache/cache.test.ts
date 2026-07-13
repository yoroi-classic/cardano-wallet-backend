import { describe, expect, it, vi } from 'vitest'
import { createMemoryCache, noCache } from '../../src/cache/index.js'

/** A clock the test moves by hand, so an entry can expire without anyone sleeping. */
function clock(start = 1_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

/** A promise a test can settle when it chooses, for driving concurrent misses. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('memory cache', () => {
  it('serves a hit without calling the loader again', async () => {
    const cache = createMemoryCache()
    const load = vi.fn(async () => 'value')

    expect(await cache.read('k', 1000, load)).toBe('value')
    expect(await cache.read('k', 1000, load)).toBe('value')

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reloads once the entry has expired', async () => {
    const time = clock()
    const cache = createMemoryCache({ now: time.now })
    const load = vi.fn(async () => 'value')

    await cache.read('k', 1000, load)
    time.advance(999)
    await cache.read('k', 1000, load)
    expect(load).toHaveBeenCalledTimes(1)

    time.advance(1)
    await cache.read('k', 1000, load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps different keys apart', async () => {
    const cache = createMemoryCache()

    expect(await cache.read('a', 1000, async () => 'A')).toBe('A')
    expect(await cache.read('b', 1000, async () => 'B')).toBe('B')
    expect(await cache.read('a', 1000, async () => 'changed')).toBe('A')
  })

  // The load spike this exists to prevent. A cold cache plus a burst of wallets must not mean N
  // identical full pool-list walks against Koios at once, which would arrive at the worst moment.
  it('collapses concurrent misses into a single load', async () => {
    const cache = createMemoryCache()
    const gate = deferred<string>()
    const load = vi.fn(() => gate.promise)

    const readers = [
      cache.read('k', 1000, load),
      cache.read('k', 1000, load),
      cache.read('k', 1000, load),
    ]
    gate.resolve('value')

    expect(await Promise.all(readers)).toEqual(['value', 'value', 'value'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  // A 502 from a wobbling provider must not be served to everyone for the next five minutes.
  it('never caches a failure', async () => {
    const cache = createMemoryCache()
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('upstream is having a moment'))
      .mockResolvedValueOnce('value')

    await expect(cache.read('k', 60_000, load)).rejects.toThrow('upstream is having a moment')

    // The very next caller gets a fresh attempt, not the stored error.
    expect(await cache.read('k', 60_000, load)).toBe('value')
    expect(load).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(1)
  })

  it('fails every caller waiting on the same failed load, then recovers', async () => {
    const cache = createMemoryCache()
    const gate = deferred<string>()
    const load = vi.fn(() => gate.promise)

    const readers = [cache.read('k', 1000, load), cache.read('k', 1000, load)]
    gate.reject(new Error('boom'))

    await expect(Promise.all(readers)).rejects.toThrow('boom')
    expect(load).toHaveBeenCalledTimes(1)

    // The failed attempt left nothing behind, so the next read starts over.
    expect(await cache.read('k', 1000, async () => 'value')).toBe('value')
  })

  it('bounds the number of live entries', async () => {
    const cache = createMemoryCache({ maxEntries: 3 })

    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      await cache.read(key, 60_000, async () => key)
    }

    expect(cache.size).toBe(3)
    // The oldest went first, the newest are still there.
    expect(await cache.read('e', 60_000, async () => 'reloaded')).toBe('e')
    expect(await cache.read('a', 60_000, async () => 'reloaded')).toBe('reloaded')
  })

  it('drops expired entries before evicting live ones', async () => {
    const time = clock()
    const cache = createMemoryCache({ maxEntries: 2, now: time.now })

    await cache.read('stale', 100, async () => 'stale')
    time.advance(200) // 'stale' is now expired but still held
    await cache.read('fresh', 60_000, async () => 'fresh')
    await cache.read('newer', 60_000, async () => 'newer')

    // Evicting took the expired entry, so both live ones survived.
    expect(cache.size).toBe(2)
    expect(await cache.read('fresh', 60_000, async () => 'reloaded')).toBe('fresh')
    expect(await cache.read('newer', 60_000, async () => 'reloaded')).toBe('newer')
  })

  it('clear() empties it', async () => {
    const cache = createMemoryCache()
    await cache.read('k', 60_000, async () => 'value')

    cache.clear()

    expect(cache.size).toBe(0)
    expect(await cache.read('k', 60_000, async () => 'reloaded')).toBe('reloaded')
  })
})

describe('noCache', () => {
  it('loads every time and stores nothing', async () => {
    const load = vi.fn(async () => 'value')

    expect(await noCache.read('k', 60_000, load)).toBe('value')
    expect(await noCache.read('k', 60_000, load)).toBe('value')

    expect(load).toHaveBeenCalledTimes(2)
    expect(noCache.size).toBe(0)
  })
})
