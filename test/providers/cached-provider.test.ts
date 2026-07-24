import { describe, expect, it, vi } from 'vitest'
import { createMemoryCache } from '../../src/cache/index.js'
import { ProviderError } from '../../src/domain/errors.js'
import { TIP_CACHE_KEY, withCache } from '../../src/providers/cached.js'
import type { ChainProvider } from '../../src/providers/provider.js'
import { fakeProvider } from '../support/fake-provider.js'

const TIP = {
  block: 3_500_000,
  slot: 86_400_123,
  epoch: 199,
  hash: 'aa11',
  blockTime: 1_700_000_000,
}

function clock(start = 1_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => void (t += ms) }
}

describe('cached provider', () => {
  it('reads the tip from upstream once and serves the rest from the cache', async () => {
    const getTip = vi.fn(async () => TIP)
    const provider = withCache(fakeProvider({ getTip }), createMemoryCache())

    expect(await provider.getTip()).toEqual(TIP)
    expect(await provider.getTip()).toEqual(TIP)
    expect(await provider.getTip()).toEqual(TIP)

    expect(getTip).toHaveBeenCalledTimes(1)
  })

  it('re-reads the tip once its window has passed', async () => {
    const time = clock()
    const getTip = vi.fn(async () => TIP)
    const provider = withCache(fakeProvider({ getTip }), createMemoryCache({ now: time.now }))

    await provider.getTip()
    time.advance(9_999)
    await provider.getTip()
    expect(getTip).toHaveBeenCalledTimes(1)

    time.advance(1)
    await provider.getTip()
    expect(getTip).toHaveBeenCalledTimes(2)
  })

  // The point of keying on the epoch rather than on a duration: the entry is valid exactly as
  // long as the thing it describes is. Within an epoch the parameters are read once, however
  // many times they are asked for, and however long the epoch lasts.
  it('reads protocol parameters once per epoch, not once per request', async () => {
    const epoch = 199
    const getTip = vi.fn(async () => ({ ...TIP, epoch }))
    const getProtocolParams = vi.fn(async () => ({ epoch, minFeeA: 44 }) as never)
    const time = clock()
    const cache = createMemoryCache({ now: time.now })
    const provider = withCache(fakeProvider({ getTip, getProtocolParams }), cache)

    await provider.getProtocolParams()
    await provider.getProtocolParams()
    expect(getProtocolParams).toHaveBeenCalledTimes(1)

    // Five days later, still the same epoch: still one upstream read. A TTL would have expired
    // many times over by now.
    time.advance(5 * 24 * 60 * 60 * 1000)
    await provider.getProtocolParams()
    expect(getProtocolParams).toHaveBeenCalledTimes(1)
  })

  it('re-reads protocol parameters when the epoch turns over', async () => {
    let epoch = 199
    const getTip = vi.fn(async () => ({ ...TIP, epoch }))
    const getProtocolParams = vi.fn(async () => ({ epoch }) as never)
    const time = clock()
    const provider = withCache(
      fakeProvider({ getTip, getProtocolParams }),
      createMemoryCache({ now: time.now }),
    )

    await provider.getProtocolParams()
    expect(getProtocolParams).toHaveBeenCalledTimes(1)

    // The epoch moves, and the cached tip ages out so the new one is seen.
    epoch = 200
    time.advance(10_000)

    await provider.getProtocolParams()
    expect(getProtocolParams).toHaveBeenCalledTimes(2)
  })

  it('retries new-tip/old-parameter lag and caches only the matching refreshed epoch', async () => {
    const getTip = vi.fn(async () => ({ ...TIP, epoch: 200 }))
    const getProtocolParams = vi
      .fn<ChainProvider['getProtocolParams']>()
      .mockResolvedValueOnce({ epoch: 199 } as never)
      .mockResolvedValueOnce({ epoch: 200 } as never)
    const cache = createMemoryCache()
    const provider = withCache(fakeProvider({ getTip, getProtocolParams }), cache)

    await expect(provider.getProtocolParams()).resolves.toEqual({ epoch: 200 })
    await expect(provider.getProtocolParams()).resolves.toEqual({ epoch: 200 })

    expect(getTip).toHaveBeenCalledTimes(2)
    expect(getProtocolParams).toHaveBeenCalledTimes(2)
    expect(cache.peek('chain:protocol-params:199')).toBeUndefined()
    expect(cache.peek('chain:protocol-params:200')).toEqual({ epoch: 200 })
  })

  it('re-keys old-tip/new-parameter mismatch from one matching fresh pair', async () => {
    const getTip = vi
      .fn<ChainProvider['getTip']>()
      .mockResolvedValueOnce({ ...TIP, epoch: 199 })
      .mockResolvedValueOnce({ ...TIP, epoch: 200 })
    const getProtocolParams = vi.fn(async () => ({ epoch: 200 }) as never)
    const cache = createMemoryCache()
    const provider = withCache(fakeProvider({ getTip, getProtocolParams }), cache)

    await expect(provider.getProtocolParams()).resolves.toEqual({ epoch: 200 })

    expect(cache.peek('chain:protocol-params:199')).toBeUndefined()
    expect(cache.peek('chain:protocol-params:200')).toEqual({ epoch: 200 })
    expect(cache.peek(TIP_CACHE_KEY)).toEqual({ ...TIP, epoch: 200 })
    expect(getTip).toHaveBeenCalledTimes(2)
    expect(getProtocolParams).toHaveBeenCalledTimes(2)
  })

  it('fails closed and retains no parameters when the refreshed pair still disagrees', async () => {
    const getTip = vi.fn(async () => ({ ...TIP, epoch: 200 }))
    const getProtocolParams = vi.fn(async () => ({ epoch: 199 }) as never)
    const cache = createMemoryCache()
    const provider = withCache(fakeProvider({ getTip, getProtocolParams }), cache)

    await expect(provider.getProtocolParams()).rejects.toThrow(ProviderError)
    expect(cache.peek('chain:protocol-params:199')).toBeUndefined()
    expect(cache.peek('chain:protocol-params:200')).toBeUndefined()

    // Neither mismatch is cached: the next request performs a fresh bounded attempt.
    await expect(provider.getProtocolParams()).rejects.toThrow(ProviderError)
    expect(getTip).toHaveBeenCalledTimes(3)
    expect(getProtocolParams).toHaveBeenCalledTimes(4)
  })

  it('coalesces concurrent epoch-boundary recovery without retaining the mismatched key', async () => {
    let releaseFreshTip: (tip: typeof TIP) => void = () => {}
    const freshTip = new Promise<typeof TIP>((resolve) => {
      releaseFreshTip = resolve
    })
    const getTip = vi
      .fn<ChainProvider['getTip']>()
      .mockResolvedValueOnce({ ...TIP, epoch: 199 })
      .mockReturnValueOnce(freshTip)
    const getProtocolParams = vi.fn(async () => ({ epoch: 200 }) as never)
    const cache = createMemoryCache()
    const provider = withCache(fakeProvider({ getTip, getProtocolParams }), cache)

    const requests = Array.from({ length: 12 }, () => provider.getProtocolParams())
    await vi.waitFor(() => expect(getTip).toHaveBeenCalledTimes(2))
    releaseFreshTip({ ...TIP, epoch: 200 })

    await expect(Promise.all(requests)).resolves.toEqual(
      Array.from({ length: 12 }, () => ({ epoch: 200 })),
    )
    expect(getTip).toHaveBeenCalledTimes(2)
    expect(getProtocolParams).toHaveBeenCalledTimes(2)
    expect(cache.peek('chain:protocol-params:199')).toBeUndefined()
    expect(cache.peek('chain:protocol-params:200')).toEqual({ epoch: 200 })
  })

  it('does not cache an upstream failure', async () => {
    const getTip = vi
      .fn<() => Promise<typeof TIP>>()
      .mockRejectedValueOnce(new Error('upstream is having a moment'))
      .mockResolvedValueOnce(TIP)
    const provider = withCache(fakeProvider({ getTip }), createMemoryCache())

    await expect(provider.getTip()).rejects.toThrow('upstream is having a moment')
    expect(await provider.getTip()).toEqual(TIP)
  })

  // The rule that must not be broken. Serving a stale balance or a stale UTxO set to a wallet
  // that is about to build a transaction produces a failed submission or a double-spend, so
  // every account-scoped read goes to upstream every single time. This test is the guard: if
  // someone adds one of these to withCache, it fails here.
  describe('never caches an account-scoped read', () => {
    const STAKE = 'stake_test1uq'

    it.each([
      [
        'getAccountState',
        (p: ChainProvider) => p.getAccountState(STAKE),
        { getAccountState: vi.fn(async () => ({ balance: '1' }) as never) },
      ],
      [
        'getAccountUtxos',
        (p: ChainProvider) => p.getAccountUtxos(STAKE),
        { getAccountUtxos: vi.fn(async () => []) },
      ],
      [
        'getTxHistory',
        (p: ChainProvider) => p.getTxHistory(STAKE),
        { getTxHistory: vi.fn(async () => []) },
      ],
      [
        'getTxStatus',
        (p: ChainProvider) => p.getTxStatus('ab'.repeat(32)),
        { getTxStatus: vi.fn(async () => ({ seen: true, confirmations: 3 })) },
      ],
    ])('%s goes upstream on every call', async (_name, call, stub) => {
      const cache = createMemoryCache()
      const provider = withCache(fakeProvider(stub), cache)

      await call(provider)
      await call(provider)
      await call(provider)

      const upstream = Object.values(stub)[0] as ReturnType<typeof vi.fn>
      expect(upstream).toHaveBeenCalledTimes(3)
      // And nothing about them was written to the cache either.
      expect(cache.size).toBe(0)
    })
  })

  it('passes through everything it does not cache', async () => {
    const filterUsedAddresses = vi.fn(async () => ['addr1'])
    const provider = withCache(fakeProvider({ filterUsedAddresses }), createMemoryCache())

    expect(await provider.filterUsedAddresses(['addr1'])).toEqual(['addr1'])
    expect(provider.name).toBe('fake')
  })
})
