import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryCache, noCache, type Cache } from '../../src/cache/index.js'
import { loadConfig } from '../../src/config/index.js'
import type { Tip } from '../../src/domain/types/chain.js'
import { TIP_TTL_MS } from '../../src/providers/cached.js'
import { createProvider, scopeProviderCache } from '../../src/providers/factory.js'

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
  const tokenSubject = 'a'.repeat(56) + '484f534b59'
  const drepId = 'drep1ygpuetneftlmufa97hm5mf3xvqpdkyw656hyg6h20qaewtg3csnkc'

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
      generation: () => memory.generation(),
      setIfGeneration: (key, value, ttlMs, generation) =>
        memory.setIfGeneration(key, value, ttlMs, generation),
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

  it('reports only entries owned by the provider-scoped view', () => {
    const cache = createMemoryCache()
    cache.set('provider:koios:preprod:chain:tip', tip(10), TIP_TTL_MS)
    cache.set('price:ada', 1, TIP_TTL_MS)

    const scoped = scopeProviderCache(cache, loadConfig({ NETWORK: 'preprod' }))

    expect(scoped.size).toBe(1)
    scoped.clear()
    expect(cache.peek('provider:koios:preprod:chain:tip')).toBeUndefined()
    expect(cache.peek('price:ada')).toBe(1)
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

  it('uses the provider view for batch peek and set keys', async () => {
    const cache = createMemoryCache()
    const cached = { subject: tokenSubject, policyId: 'a'.repeat(56), assetName: '484f534b59' }
    cache.set(`provider:koios:preprod:asset:meta:${tokenSubject}`, cached, 60_000)
    const fetchImpl = vi.fn().mockResolvedValue(
      response([
        {
          policy_id: 'b'.repeat(56),
          asset_name: '484f534b59',
          asset_name_ascii: 'HOSKY',
          fingerprint: 'asset1hosky',
          total_supply: '1',
          name: 'HOSKY',
          ticker: 'HOSKY',
          description: null,
          url: null,
          decimals: 0,
        },
      ]),
    )
    vi.stubGlobal('fetch', fetchImpl)
    const provider = createProvider(loadConfig({ NETWORK: 'preprod' }), { cache })

    await expect(provider.getTokenMetadata([tokenSubject])).resolves.toEqual([cached])
    await expect(provider.getTokenMetadata(['b'.repeat(56) + '484f534b59'])).resolves.toHaveLength(
      1,
    )
    expect(
      cache.peek(`provider:koios:preprod:asset:meta:${'b'.repeat(56) + '484f534b59'}`),
    ).toBeDefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not let a batch metadata load repopulate a namespace cleared while upstream is pending', async () => {
    const cache = createMemoryCache()
    const config = loadConfig({ NETWORK: 'preprod' })
    const subject = 'b'.repeat(56) + '484f534b59'
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/asset_info')) {
        markStarted()
        await blocked
      }
      return response([
        {
          policy_id: 'b'.repeat(56),
          asset_name: '484f534b59',
          asset_name_ascii: 'HOSKY',
          fingerprint: 'asset1hosky',
          total_supply: '1',
          name: 'HOSKY',
          ticker: 'HOSKY',
          description: null,
          url: null,
          decimals: 0,
        },
      ])
    })
    vi.stubGlobal('fetch', fetchImpl)
    const provider = createProvider(config, { cache })

    const pending = provider.getTokenMetadata([subject])
    await started
    scopeProviderCache(cache, config).clear()
    release()
    await pending

    expect(cache.peek(`provider:koios:preprod:asset:meta:${subject}`)).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('keeps the uncached governance walk bounded when noCache is injected', async () => {
    const cache = noCache
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/drep_list')) {
        const after = new URL(url).searchParams.get('drep_id')
        const rows = after
          ? []
          : Array.from({ length: 1_000 }, () => ({ drep_id: drepId, registered: true }))
        return response(rows)
      }
      if (url.includes('/drep_info')) {
        return response([
          {
            drep_id: drepId,
            hex: '03ccae794affbe27a5f5f74da6266002db11daa6ae446aea783b972d',
            has_script: false,
            drep_status: 'registered',
            active: true,
            deposit: '500000000',
            amount: '1',
            expires_epoch_no: 219,
            meta_url: null,
            meta_hash: null,
          },
        ])
      }
      void init
      return response([])
    })
    vi.stubGlobal('fetch', fetchImpl)
    const provider = createProvider(loadConfig({ NETWORK: 'preprod' }), { cache })

    await expect(provider.getDrepList({ limit: 1, offset: 0 })).resolves.toHaveLength(1)
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/drep_list'))).toHaveLength(
      1,
    )
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
