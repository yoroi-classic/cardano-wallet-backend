import { describe, expect, it } from 'vitest'
import { bech32 } from '@scure/base'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'
import { MalformedUpstreamError } from '../../src/domain/errors.js'
import { drepCredentialHex } from '../../src/domain/drep.js'

const BASE = 'https://preprod.koios.rest/api/v1'
// Both are real CIP-129 ids: A carries a key-hash credential (header 0x22), B a script one
// (header 0x23).
const DREP_A = 'drep1ygpuetneftlmufa97hm5mf3xvqpdkyw656hyg6h20qaewtg3csnkc'
const DREP_B = 'drep1y07lewz4r9svtyymalt0a8x0uapsra7xfwtu4df3n9mna2quw7syr'

// The same DRep as DREP_A, written in the deprecated CIP-105 form: the bare 28-byte
// credential, with no CIP-129 header byte.
const DREP_A_CIP105 = bech32.encode(
  'drep',
  bech32.toWords(Buffer.from(drepCredentialHex(DREP_A) ?? '', 'hex')),
  1023,
)

// A valid CIP-129 id (0x22 key-hash header) over a distinct credential, for batch tests.
function syntheticDrepId(n: number): string {
  const credential = Buffer.alloc(28)
  credential.writeUInt32BE(n, 0)
  return bech32.encode(
    'drep',
    bech32.toWords(Buffer.concat([Buffer.from([0x22]), credential])),
    1023,
  )
}

interface Call {
  url: string
  method?: string
  body?: string | Uint8Array
}

// Shaped after a live Koios /drep_info row. `hex` is derived from the id rather than fixed,
// because that is the relationship Koios actually maintains, and the provider now keys its
// lookup on hex. A canned constant here would let two different DReps share a credential
// and quietly hide a mismatch.
function drepRow(drepId: string): Record<string, unknown> {
  return {
    drep_id: drepId,
    hex: drepCredentialHex(drepId),
    has_script: false,
    drep_status: 'registered',
    active: false,
    deposit: '500000000',
    amount: '820331766436',
    expires_epoch_no: 219,
    meta_url: null,
    meta_hash: null,
  }
}

function fakeFetch(json: () => Promise<unknown>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body })
    return { ok: true, status: 200, json, text: async () => '' }
  }
  return { fetchImpl, calls }
}

// Routes /drep_list and /drep_info to different responses (getDrepList calls both), serving
// /drep_list in Koios-sized pages so the provider's paging is exercised, and answering
// /drep_info from whatever ids the body asked for, like the real endpoint.
function routedFetch(
  listRows: Array<Record<string, unknown>>,
  infoRows: Array<Record<string, unknown>>,
  pageSize = 1000,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body })
    let rows: unknown
    if (url.includes('/drep_list')) {
      const offset = Number(new URL(url).searchParams.get('offset') ?? 0)
      rows = listRows.slice(offset, offset + pageSize)
    } else {
      const asked = new Set(
        (JSON.parse(String(init?.body ?? '{}')) as { _drep_ids?: string[] })._drep_ids ?? [],
      )
      rows = infoRows.filter((r) => asked.has(r['drep_id'] as string))
    }
    return { ok: true, status: 200, json: async () => rows, text: async () => '' }
  }
  return { fetchImpl, calls }
}

describe('koios getDrepInfo', () => {
  it('maps a drep row and posts the drep ids', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [drepRow(DREP_A)])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [drep] = await provider.getDrepInfo([DREP_A])

    expect(drep).toEqual({
      drepId: DREP_A,
      hex: '03ccae794affbe27a5f5f74da6266002db11daa6ae446aea783b972d',
      hasScript: false,
      status: 'registered',
      active: false,
      deposit: '500000000',
      votingPower: '820331766436',
      expiresEpoch: 219,
    })
    expect(calls[0]?.url).toBe(`${BASE}/drep_info`)
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ _drep_ids: [DREP_A] })
  })

  it('returns dreps in the caller order and omits unknown ids', async () => {
    const { fetchImpl } = fakeFetch(async () => [drepRow(DREP_B), drepRow(DREP_A)])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const dreps = await provider.getDrepInfo([DREP_A, 'drep1unknown', DREP_B])

    expect(dreps.map((d) => d.drepId)).toEqual([DREP_A, DREP_B])
  })

  it('returns [] without calling upstream for an empty batch', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => [drepRow(DREP_A)])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    expect(await provider.getDrepInfo([])).toEqual([])
    expect(calls).toHaveLength(0)
  })

  // A DRep has two bech32 encodings of one credential: CIP-129 (current) and CIP-105
  // (deprecated). Koios takes either on the way in but always answers with the CIP-129 id,
  // so matching the response back to the caller's own string would drop a DRep asked for by
  // its CIP-105 id. Matching on the credential hex is what makes both forms work.
  it('resolves a drep asked for by its deprecated CIP-105 id', async () => {
    const { fetchImpl } = fakeFetch(async () => [drepRow(DREP_A)])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [drep] = await provider.getDrepInfo([DREP_A_CIP105])

    expect(drep).toBeDefined()
    // The CIP-129 id is what comes back out, whichever form went in.
    expect(drep?.drepId).toBe(DREP_A)
    expect(drep?.hex).toBe(drepCredentialHex(DREP_A))
  })

  // The spec declares three statuses. not_registered never appears in a drep_list row, but
  // it is what a query for a never-registered DRep id comes back with, so it has to parse.
  it('accepts every drep_status the koios spec declares', async () => {
    for (const status of ['registered', 'deregistered', 'not_registered']) {
      const { fetchImpl } = fakeFetch(async () => [{ ...drepRow(DREP_A), drep_status: status }])
      const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

      const [drep] = await provider.getDrepInfo([DREP_A])

      expect(drep?.status).toBe(status)
    }
  })

  // Name resolution is best-effort, and that has to hold for every way drep_metadata can go
  // wrong, not just an outright failure. A 200 carrying an unexpected shape is the likeliest
  // case (Koios changing a field we do not even need), and it must not take the DRep with it.
  it.each([
    ['a schema mismatch on a 200', { ok: true, body: [{ unexpected: 'shape' }] }],
    ['a hard failure', { ok: false, body: [] }],
    ['a non-array body', { ok: true, body: { not: 'an array' } }],
  ])('still returns drep info when drep_metadata answers with %s', async (_case, meta) => {
    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body })
      if (url.endsWith('/drep_metadata')) {
        return {
          ok: meta.ok,
          status: meta.ok ? 200 : 500,
          json: async () => meta.body,
          text: async () => '',
        }
      }
      return { ok: true, status: 200, json: async () => [drepRow(DREP_A)], text: async () => '' }
    }
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [drep] = await provider.getDrepInfo([DREP_A])

    // The on-chain info survives; only the name is missing.
    expect(drep?.drepId).toBe(DREP_A)
    expect(drep?.status).toBe('registered')
    expect(drep?.votingPower).toBe('820331766436')
    expect(drep?.name).toBeUndefined()
  })

  it('rejects an unexpected drep_status as malformed upstream', async () => {
    const { fetchImpl } = fakeFetch(async () => [{ ...drepRow(DREP_A), drep_status: 'sleeping' }])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await expect(provider.getDrepInfo([DREP_A])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  // Koios answers an oversized body with a 413, the same as /pool_info, so a full batch has
  // to go up in chunks.
  it('hydrates a large batch in chunks of 50 ids', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => syntheticDrepId(i))
    const { fetchImpl, calls } = fakeFetch(async () => [])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await provider.getDrepInfo(ids)

    // Both drep_info and its best-effort drep_metadata companion have to respect the cap.
    for (const path of ['/drep_info', '/drep_metadata']) {
      const sent = calls.filter((c) => c.url.endsWith(path))
      expect(sent, path).toHaveLength(3)
      for (const call of sent) {
        const body = (JSON.parse(String(call.body)) as { _drep_ids: string[] })._drep_ids
        expect(body.length).toBeLessThanOrEqual(50)
      }
    }
  })
})

// Routes /drep_info and /drep_metadata to separate responses; /drep_metadata may throw.
function infoAndMetaFetch(
  infoRows: unknown,
  metaRows: unknown | (() => never),
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body })
    if (url.includes('/drep_metadata')) {
      if (typeof metaRows === 'function') return metaRows()
      return { ok: true, status: 200, json: async () => metaRows, text: async () => '' }
    }
    return { ok: true, status: 200, json: async () => infoRows, text: async () => '' }
  }
  return { fetchImpl, calls }
}

describe('koios getDrepInfo off-chain metadata resolution', () => {
  it('resolves a CIP-119 givenName and image', async () => {
    const { fetchImpl } = infoAndMetaFetch(
      [drepRow(DREP_A)],
      [
        {
          drep_id: DREP_A,
          meta_json: { body: { givenName: 'Eternal_MK', image: { contentUrl: 'ipfs://Qm' } } },
        },
      ],
    )
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [drep] = await provider.getDrepInfo([DREP_A])
    expect(drep?.name).toBe('Eternal_MK')
    expect(drep?.image).toBe('ipfs://Qm')
  })

  it('falls back to a flat top-level name', async () => {
    const { fetchImpl } = infoAndMetaFetch(
      [drepRow(DREP_A)],
      [{ drep_id: DREP_A, meta_json: { name: 'Flat Name', ticker: 'FN' } }],
    )
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [drep] = await provider.getDrepInfo([DREP_A])
    expect(drep?.name).toBe('Flat Name')
    expect(drep?.image).toBeUndefined()
  })

  it('leaves the name unset when metadata is null or unfetched', async () => {
    const { fetchImpl } = infoAndMetaFetch(
      [drepRow(DREP_A)],
      [{ drep_id: DREP_A, meta_json: null }],
    )
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [drep] = await provider.getDrepInfo([DREP_A])
    expect(drep?.name).toBeUndefined()
  })

  it('still returns drep info when the metadata call fails', async () => {
    const { fetchImpl } = infoAndMetaFetch([drepRow(DREP_A)], () => {
      throw new Error('drep_metadata upstream error')
    })
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const [drep] = await provider.getDrepInfo([DREP_A])
    expect(drep?.drepId).toBe(DREP_A)
    expect(drep?.name).toBeUndefined()
  })
})

describe('koios getDrepList', () => {
  it('returns a neutral page of registered dreps, hydrated in order', async () => {
    const { fetchImpl, calls } = routedFetch(
      [
        { drep_id: DREP_A, registered: true },
        { drep_id: DREP_B, registered: true },
      ],
      [drepRow(DREP_B), drepRow(DREP_A)],
    )
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const dreps = await provider.getDrepList({ limit: 50, offset: 0 })

    expect(dreps.map((d) => d.drepId)).toEqual([DREP_A, DREP_B])
    const listCall = calls[0]?.url ?? ''
    expect(listCall).toContain('/drep_list')
    expect(listCall).toContain('order=drep_id.asc')
    expect(calls[1]?.url).toBe(`${BASE}/drep_info`)
  })

  // The registered filter is deliberately not pushed upstream: on mainnet, Koios answers a
  // filtered drep_list with "column record.registered does not exist" about a third of the
  // time, so the endpoint would fail at random. The rows always carry the field, so the
  // filter is applied here instead. Reported upstream as koios-artifacts#411.
  it('does not push the registered filter upstream, and drops unregistered dreps here', async () => {
    const { fetchImpl, calls } = routedFetch(
      [
        { drep_id: DREP_A, registered: false },
        { drep_id: DREP_B, registered: true },
      ],
      [drepRow(DREP_A), drepRow(DREP_B)],
    )
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    const dreps = await provider.getDrepList({ limit: 50, offset: 0 })

    expect(calls[0]?.url ?? '').not.toContain('registered=eq.')
    expect(dreps.map((d) => d.drepId)).toEqual([DREP_B])
  })

  // Paging has to be applied after the filter, not before it, or a page that happens to
  // contain unregistered DReps comes back short.
  it('pages the filtered set, not the raw upstream rows', async () => {
    const rows = [
      { drep_id: syntheticDrepId(1), registered: true },
      { drep_id: syntheticDrepId(2), registered: false },
      { drep_id: syntheticDrepId(3), registered: true },
      { drep_id: syntheticDrepId(4), registered: true },
    ]
    const info = rows.map((r) => drepRow(r.drep_id))
    const provider = createKoiosProvider({
      baseUrl: BASE,
      fetchImpl: routedFetch(rows, info).fetchImpl,
    })

    const first = await provider.getDrepList({ limit: 2, offset: 0 })
    const second = await provider.getDrepList({ limit: 2, offset: 2 })

    // The unregistered DRep is gone entirely, so the first page is full and the second
    // carries the remaining registered one.
    expect(first.map((d) => d.drepId)).toEqual([syntheticDrepId(1), syntheticDrepId(3)])
    expect(second.map((d) => d.drepId)).toEqual([syntheticDrepId(4)])
  })

  it('follows koios paging until a short page ends the walk', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      drep_id: syntheticDrepId(i),
      registered: true,
    }))
    const { fetchImpl, calls } = routedFetch(rows, [drepRow(syntheticDrepId(0))])
    const provider = createKoiosProvider({ baseUrl: BASE, fetchImpl })

    await provider.getDrepList({ limit: 1, offset: 0 })

    const listCalls = calls.filter((c) => c.url.includes('/drep_list'))
    expect(listCalls).toHaveLength(2)
    expect(listCalls[0]?.url).toContain('offset=0')
    expect(listCalls[1]?.url).toContain('offset=1000')
  })
})
