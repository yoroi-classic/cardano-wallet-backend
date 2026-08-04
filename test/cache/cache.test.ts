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

  it('reports the size of a key prefix without counting other consumers', () => {
    const cache = createMemoryCache()
    cache.set('provider:koios:preprod:tip', 1, 60_000)
    cache.set('provider:koios:mainnet:tip', 2, 60_000)
    cache.set('price:ada', 3, 60_000)

    expect(cache.sizeForPrefix?.('provider:koios:preprod:')).toBe(1)
    expect(cache.sizeForPrefix?.('provider:')).toBe(2)
    expect(cache.size).toBe(3)
  })

  it('does not let a load that crossed clear repopulate the cache', async () => {
    const cache = createMemoryCache()
    const first = deferred<string>()
    const second = deferred<string>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const oldRead = cache.read('provider:koios:preprod:tip', 60_000, load)
    cache.clear('provider:koios:preprod:')
    const newRead = cache.read('provider:koios:preprod:tip', 60_000, load)

    first.resolve('stale')
    second.resolve('fresh')
    await expect(oldRead).resolves.toBe('stale')
    await expect(newRead).resolves.toBe('fresh')
    expect(cache.peek('provider:koios:preprod:tip')).toBe('fresh')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not invalidate an unrelated in-flight namespace', async () => {
    const cache = createMemoryCache()
    const gate = deferred<string>()
    const load = vi.fn(() => gate.promise)

    const first = cache.read('provider:koios:preprod:tip', 60_000, load)
    cache.clear('price:')
    const second = cache.read('provider:koios:preprod:tip', 60_000, load)

    expect(second).toBe(first)
    gate.resolve('value')
    await expect(second).resolves.toBe('value')
    expect(load).toHaveBeenCalledTimes(1)
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

  it('coalesces a synchronous loader throw, clears it, then retries', async () => {
    const cache = createMemoryCache()
    const load = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => {
        throw new Error('thrown before returning a promise')
      })
      .mockResolvedValueOnce('value')

    const first = cache.read('k', 1000, load)
    const concurrent = cache.read('k', 1000, load)

    // The loader is deferred until after the attempt is registered, so same-turn readers share
    // one promise even when the loader will throw before returning its own promise.
    expect(load).not.toHaveBeenCalled()
    expect(concurrent).toBe(first)
    await Promise.all([
      expect(first).rejects.toThrow('thrown before returning a promise'),
      expect(concurrent).rejects.toThrow('thrown before returning a promise'),
    ])
    expect(load).toHaveBeenCalledTimes(1)

    // Cleanup ran after registration, so the rejected attempt cannot poison the key.
    expect(await cache.read('k', 1000, load)).toBe('value')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('coalesces an asynchronously rejected load, clears it, then recovers', async () => {
    const cache = createMemoryCache()
    const gate = deferred<string>()
    const load = vi.fn(() => gate.promise)

    const first = cache.read('k', 1000, load)
    const concurrent = cache.read('k', 1000, load)
    expect(concurrent).toBe(first)
    gate.reject(new Error('boom'))

    await Promise.all([
      expect(first).rejects.toThrow('boom'),
      expect(concurrent).rejects.toThrow('boom'),
    ])
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

  it('clear(prefix) only removes entries in that namespace', async () => {
    const cache = createMemoryCache()
    await cache.read('provider:koios:preprod:tip', 60_000, async () => 'tip')
    await cache.read('price:ada', 60_000, async () => 'price')

    cache.clear('provider:koios:preprod:')

    expect(cache.size).toBe(1)
    expect(cache.peek('provider:koios:preprod:tip')).toBeUndefined()
    expect(cache.peek('price:ada')).toBe('price')
  })

  it('setIfGeneration keeps unrelated namespace writes after a clear', () => {
    const cache = createMemoryCache()
    const providerGeneration = cache.generation('provider:')

    cache.clear('price:')
    cache.setIfGeneration('provider:koios:tip', 'tip', 60_000, providerGeneration)

    expect(cache.peek('provider:koios:tip')).toBe('tip')
  })

  it('clear() prevents an older attempt from caching or deleting its replacement', async () => {
    const cache = createMemoryCache()
    const oldLoad = deferred<string>()
    const replacementLoad = deferred<string>()

    const oldAttempt = cache.read('k', 60_000, () => oldLoad.promise)
    cache.clear()
    const replacement = cache.read('k', 60_000, () => replacementLoad.promise)

    oldLoad.resolve('old')
    await expect(oldAttempt).resolves.toBe('old')
    expect(cache.peek('k')).toBeUndefined()

    const concurrent = cache.read('k', 60_000, async () => 'unexpected')
    expect(concurrent).toBe(replacement)

    replacementLoad.resolve('new')
    await expect(replacement).resolves.toBe('new')
    expect(cache.peek('k')).toBe('new')
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

describe('peek and set (for batch loads)', () => {
  it('peek returns undefined for a key never set, and the value after set', () => {
    const cache = createMemoryCache()

    expect(cache.peek('k')).toBeUndefined()
    cache.set('k', 'value', 1000)
    expect(cache.peek('k')).toBe('value')
  })

  it('peek stops returning a value once its TTL passes', () => {
    const time = clock()
    const cache = createMemoryCache({ now: time.now })
    cache.set('k', 'value', 1000)

    time.advance(999)
    expect(cache.peek('k')).toBe('value')
    time.advance(1)
    expect(cache.peek('k')).toBeUndefined()
  })

  // The batch-load shape this exists for: peek the hits, one upstream call for the misses, set
  // each. peek must never touch upstream, which is what lets the caller decide how to fetch.
  it('peek never loads, so a caller can batch the misses itself', async () => {
    const cache = createMemoryCache()
    cache.set('a', 1, 60_000)

    const keys = ['a', 'b', 'c']
    const misses = keys.filter((k) => cache.peek(k) === undefined)

    expect(misses).toEqual(['b', 'c'])
    // Simulate one batch fetch for the misses.
    for (const k of misses) cache.set(k, 99, 60_000)
    expect(keys.map((k) => cache.peek(k))).toEqual([1, 99, 99])
  })

  it('set counts toward the entry bound like any other entry', () => {
    const cache = createMemoryCache({ maxEntries: 2 })

    cache.set('a', 1, 60_000)
    cache.set('b', 2, 60_000)
    cache.set('c', 3, 60_000)

    expect(cache.size).toBe(2)
  })

  it('noCache never remembers a set', () => {
    noCache.set('k', 'value', 60_000)
    expect(noCache.peek('k')).toBeUndefined()
  })
})
