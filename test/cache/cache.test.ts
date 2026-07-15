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

describe('stale-if-error', () => {
  /** A loader that succeeds, then fails on demand. */
  function flaky(value: string) {
    let failing = false
    const load = async (): Promise<string> => {
      if (failing) throw new Error('upstream is having a moment')
      return value
    }
    return { load, breakIt: () => void (failing = true) }
  }

  // The property that turns an upstream wobble into slightly-old data instead of a 504. Measured
  // on live mainnet, a quarter of pool-list requests fail today; a saturation figure two minutes
  // old is worth immeasurably more to the person choosing a pool than an error page.
  it('serves the last good value when a refresh fails', async () => {
    const time = clock()
    const cache = createMemoryCache({ now: time.now })
    const upstream = flaky('pools')

    expect(await cache.read('k', { ttlMs: 1000, staleIfErrorMs: 60_000 }, upstream.load)).toBe(
      'pools',
    )

    time.advance(2000) // past the TTL, inside the stale window
    upstream.breakIt()

    expect(await cache.read('k', { ttlMs: 1000, staleIfErrorMs: 60_000 }, upstream.load)).toBe(
      'pools',
    )
  })

  // Not a longer TTL, and the difference is the whole point: inside the TTL we never ask upstream,
  // past it we do, and this only changes what happens when that ask *fails*.
  it('still refreshes when upstream is healthy', async () => {
    const time = clock()
    const cache = createMemoryCache({ now: time.now })
    const load = vi.fn(async () => 'v')

    await cache.read('k', { ttlMs: 1000, staleIfErrorMs: 60_000 }, load)
    time.advance(2000)
    await cache.read('k', { ttlMs: 1000, staleIfErrorMs: 60_000 }, load)

    expect(load).toHaveBeenCalledTimes(2)
  })

  // An outage has to surface eventually. Data this old is not "slightly stale", it is wrong, and a
  // wallet showing it would be lying to someone about the state of the chain.
  it('gives up once the value is older than the stale window', async () => {
    const time = clock()
    const cache = createMemoryCache({ now: time.now })
    const upstream = flaky('pools')

    await cache.read('k', { ttlMs: 1000, staleIfErrorMs: 60_000 }, upstream.load)

    time.advance(120_000) // past TTL *and* past the stale window
    upstream.breakIt()

    await expect(
      cache.read('k', { ttlMs: 1000, staleIfErrorMs: 60_000 }, upstream.load),
    ).rejects.toThrow('upstream is having a moment')
  })

  it('does not extend the window each time a refresh fails', async () => {
    const time = clock()
    const cache = createMemoryCache({ now: time.now })
    const upstream = flaky('pools')

    await cache.read('k', { ttlMs: 1000, staleIfErrorMs: 10_000 }, upstream.load)
    upstream.breakIt()

    // Repeated failed refreshes inside the window keep serving the value...
    time.advance(5000)
    expect(await cache.read('k', { ttlMs: 1000, staleIfErrorMs: 10_000 }, upstream.load)).toBe(
      'pools',
    )

    // ...but they do not reset the clock. A long outage still ends in an error rather than in a
    // value that gets quietly renewed forever on the strength of it never succeeding.
    time.advance(10_000)
    await expect(
      cache.read('k', { ttlMs: 1000, staleIfErrorMs: 10_000 }, upstream.load),
    ).rejects.toThrow()
  })

  // The rule that must not be broken. Account-scoped data has no acceptable stale value: a stale
  // balance or UTxO set handed to a wallet about to build a transaction produces a failed
  // submission or a double-spend. "Upstream was down" is not a licence to guess at someone's money.
  it('is off by default, so a plain TTL never serves stale data', async () => {
    const time = clock()
    const cache = createMemoryCache({ now: time.now })
    const upstream = flaky('balance')

    await cache.read('account', 1000, upstream.load)

    time.advance(2000)
    upstream.breakIt()

    await expect(cache.read('account', 1000, upstream.load)).rejects.toThrow()
  })
})
