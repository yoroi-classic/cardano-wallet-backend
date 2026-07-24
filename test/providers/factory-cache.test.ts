import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryCache, type Cache } from '../../src/cache/index.js'
import { loadConfig } from '../../src/config/index.js'
import type { Tip } from '../../src/domain/types/chain.js'
import { TIP_TTL_MS } from '../../src/providers/cached.js'
import { createProvider } from '../../src/providers/factory.js'

const tip = (network: number): Tip => ({
  block: network,
  slot: network,
  epoch: network,
  hash: String(network),
  blockTime: network,
})

const tipRow = (network: number) => ({
  block_no: network,
  abs_slot: network,
  epoch_no: network,
  hash: String(network),
  block_time: network,
})

const response = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('provider factory cache ownership', () => {
  it('uses the exact injected process cache through a provider/network-scoped view', async () => {
    const memory = createMemoryCache()
    const reads: string[] = []
    const injected: Cache = {
      read: (key, policy, load) => {
        reads.push(key)
        return memory.read(key, policy, load)
      },
      peek: (key) => memory.peek(key),
      set: (key, value, ttlMs) => memory.set(key, value, ttlMs),
      get size() {
        return memory.size
      },
      clear: () => memory.clear(),
    }
    const cached = tip(10)
    injected.set('provider:koios:preprod:chain:tip', cached, TIP_TTL_MS)
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)

    const provider = createProvider(loadConfig({ NETWORK: 'preprod' }), { cache: injected })

    await expect(provider.getTip()).resolves.toEqual(cached)
    expect(reads).toEqual(['provider:koios:preprod:chain:tip'])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('isolates shared entries by both network and provider', async () => {
    const cache = createMemoryCache()
    cache.set('provider:koios:preprod:chain:tip', tip(10), TIP_TTL_MS)
    cache.set('provider:koios:mainnet:chain:tip', tip(11), TIP_TTL_MS)
    cache.set('provider:blockfrost:preprod:chain:tip', tip(12), TIP_TTL_MS)
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)

    const koiosPreprod = createProvider(loadConfig({ NETWORK: 'preprod' }), { cache })
    const koiosMainnet = createProvider(loadConfig({ NETWORK: 'mainnet' }), { cache })
    const blockfrostPreprod = createProvider(
      loadConfig({
        NETWORK: 'preprod',
        PROVIDER: 'blockfrost',
        BLOCKFROST_PROJECT_ID: 'project',
      }),
      { cache },
    )

    await expect(koiosPreprod.getTip()).resolves.toEqual(tip(10))
    await expect(koiosMainnet.getTip()).resolves.toEqual(tip(11))
    await expect(blockfrostPreprod.getTip()).resolves.toEqual(tip(12))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('gives standalone providers separate configured memory-cache fallbacks', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response([tipRow(20)]))
      .mockResolvedValueOnce(response([tipRow(21)]))
    vi.stubGlobal('fetch', fetchImpl)

    const first = createProvider(loadConfig({ NETWORK: 'preprod' }))
    const second = createProvider(loadConfig({ NETWORK: 'preprod' }))

    await expect(first.getTip()).resolves.toEqual(tip(20))
    await expect(first.getTip()).resolves.toEqual(tip(20))
    await expect(second.getTip()).resolves.toEqual(tip(21))
    await expect(second.getTip()).resolves.toEqual(tip(21))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retains the no-cache fallback for standalone disabled-cache construction', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response([tipRow(30)]))
      .mockResolvedValueOnce(response([tipRow(31)]))
    vi.stubGlobal('fetch', fetchImpl)
    const provider = createProvider(loadConfig({ CACHE_ENABLED: 'false' }))

    await expect(provider.getTip()).resolves.toEqual(tip(30))
    await expect(provider.getTip()).resolves.toEqual(tip(31))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
