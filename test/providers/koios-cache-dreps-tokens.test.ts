import { describe, expect, it } from 'vitest'
import { bech32 } from '@scure/base'
import { createMemoryCache } from '../../src/cache/index.js'
import { drepCredentialHex } from '../../src/domain/drep.js'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'

const BASE = 'https://preprod.koios.rest/api/v1'
const DREP = 'drep1ygpuetneftlmufa97hm5mf3xvqpdkyw656hyg6h20qaewtg3csnkc'
const DREP_HEX = drepCredentialHex(DREP)

/** Counts calls per path and serves realistic DRep list / info / metadata rows. */
function fakeKoios() {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const path = url.replace(BASE, '').split('?')[0] ?? ''
    calls.push(path)

    if (path === '/drep_list') {
      // One registered DRep, then a short page ends the walk.
      const after = new URL(url).searchParams.get('drep_id')
      const rows = after ? [] : [{ drep_id: DREP, registered: true }]
      return { ok: true, status: 200, json: async () => rows, text: async () => '' }
    }
    if (path === '/drep_info') {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            drep_id: DREP,
            hex: DREP_HEX,
            has_script: false,
            drep_status: 'registered',
            active: true,
            deposit: '500000000',
            amount: '820331766436',
            expires_epoch_no: 219,
            meta_url: null,
            meta_hash: null,
          },
        ],
        text: async () => '',
      }
    }
    if (path === '/drep_metadata') {
      return {
        ok: true,
        status: 200,
        json: async () => [{ drep_id: DREP, meta_json: { body: { givenName: 'Alice' } } }],
        text: async () => '',
      }
    }
    void init
    return { ok: true, status: 200, json: async () => [], text: async () => '' }
  }
  return { fetchImpl, calls, countOf: (p: string) => calls.filter((c) => c === p).length }
}

const provider = (koios: ReturnType<typeof fakeKoios>, cache = createMemoryCache()) =>
  createKoiosProvider({ baseUrl: BASE, fetchImpl: koios.fetchImpl, cache, readAttempts: 1 })

describe('the DRep list is cached', () => {
  // The read this replaces cannot push its filter upstream (Koios fails registered=eq.true about
  // half the time on mainnet), so every request scanned the whole list. Caching the membership
  // turns that from once-per-request into once-per-two-minutes.
  it('scans the membership list once across repeated requests', async () => {
    const koios = fakeKoios()
    const p = provider(koios)

    await p.getDrepList({ limit: 50, offset: 0 })
    await p.getDrepList({ limit: 50, offset: 0 })
    await p.getDrepList({ limit: 50, offset: 0 })

    // The list walk happens once...
    expect(koios.countOf('/drep_list')).toBe(1)
  })

  // ...but the numbers are NOT cached. votingPower and active are what someone reads while
  // deciding who to delegate to, so drep_info is hydrated fresh on every request.
  it('hydrates the DRep info fresh every time, so voting power is never stale', async () => {
    const koios = fakeKoios()
    const p = provider(koios)

    await p.getDrepList({ limit: 50, offset: 0 })
    await p.getDrepList({ limit: 50, offset: 0 })

    expect(koios.countOf('/drep_info')).toBe(2)
  })

  // Off-chain names change only on a metadata update, so once resolved they are cached. The
  // second request re-hydrates the (volatile) info but skips the (stable) name lookup.
  it('caches the off-chain names, skipping the metadata call on a warm request', async () => {
    const koios = fakeKoios()
    const p = provider(koios)

    const [first] = await p.getDrepList({ limit: 50, offset: 0 })
    expect(first?.name).toBe('Alice')
    await p.getDrepList({ limit: 50, offset: 0 })

    expect(koios.countOf('/drep_metadata')).toBe(1)
  })

  it('serves a stale membership list rather than failing when the walk breaks', async () => {
    let t = 1_000
    let broken = false
    const calls: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      const path = url.replace(BASE, '').split('?')[0] ?? ''
      calls.push(path)
      if (broken && path === '/drep_list') {
        return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' }
      }
      const koios = fakeKoios()
      return koios.fetchImpl(url)
    }
    const p = createKoiosProvider({
      baseUrl: BASE,
      fetchImpl,
      cache: createMemoryCache({ now: () => t }),
      readAttempts: 1,
    })

    expect(await p.getDrepList({ limit: 50, offset: 0 })).toHaveLength(1)

    t += 3 * 60_000 // past the 2-minute membership TTL, inside the 10-minute stale window
    broken = true

    // The membership survives the outage. (drep_info still succeeds in this fake, which is the
    // point: a wobble in the list walk should not blank the governance screen.)
    expect(await p.getDrepList({ limit: 50, offset: 0 })).toHaveLength(1)
  })
})

describe('token metadata is cached per subject', () => {
  const POLICY = 'a'.repeat(56)
  const NAME = '484f534b59'
  const SUBJECT = POLICY + NAME

  function tokenFake() {
    const calls: string[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(url.replace(BASE, '').split('?')[0] ?? '')
      const asked = JSON.parse(String(init?.body)) as { _asset_list: [string, string][] }
      const rows = asked._asset_list.map(([p, n]) => ({
        policy_id: p,
        asset_name: n,
        asset_name_ascii: 'HOSKY',
        fingerprint: 'asset1hosky',
        total_supply: '1000000000',
        name: 'HOSKY',
        ticker: 'HOSKY',
        description: null,
        url: null,
        decimals: 0,
      }))
      return { ok: true, status: 200, json: async () => rows, text: async () => '' }
    }
    return { fetchImpl, calls: () => calls }
  }

  it('asks upstream once for a repeated subject', async () => {
    const koios = tokenFake()
    const p = createKoiosProvider({
      baseUrl: BASE,
      fetchImpl: koios.fetchImpl,
      cache: createMemoryCache(),
    })

    await p.getTokenMetadata([SUBJECT])
    await p.getTokenMetadata([SUBJECT])

    expect(koios.calls().filter((c) => c.includes('/asset_info'))).toHaveLength(1)
  })

  // The win is a mixed batch: some subjects cached, some not. Only the misses go upstream.
  it('fetches only the subjects it has not seen', async () => {
    const koios = tokenFake()
    const cache = createMemoryCache()
    const p = createKoiosProvider({ baseUrl: BASE, fetchImpl: koios.fetchImpl, cache })
    const other = 'b'.repeat(56) + NAME

    await p.getTokenMetadata([SUBJECT]) // warms SUBJECT
    const bodies: string[] = []
    const counting = createKoiosProvider({
      baseUrl: BASE,
      cache,
      fetchImpl: async (url, init) => {
        bodies.push(String(init?.body))
        return koios.fetchImpl(url, init)
      },
    })

    await counting.getTokenMetadata([SUBJECT, other])

    // The second call's upstream request asked only for the uncached subject.
    const requested = JSON.parse(bodies[0] ?? '{}') as { _asset_list: [string, string][] }
    expect(requested._asset_list).toEqual([[other.slice(0, 56), NAME]])
  })

  it('returns cached and freshly-fetched subjects in the caller order', async () => {
    const koios = tokenFake()
    const cache = createMemoryCache()
    const p = createKoiosProvider({ baseUrl: BASE, fetchImpl: koios.fetchImpl, cache })
    const other = 'c'.repeat(56) + NAME

    await p.getTokenMetadata([other]) // warm `other`
    const tokens = await p.getTokenMetadata([SUBJECT, other])

    expect(tokens.map((t) => t.subject)).toEqual([SUBJECT, other])
  })
})

// Bech32 is imported only to keep the DRep constant honest against drepCredentialHex.
void bech32
