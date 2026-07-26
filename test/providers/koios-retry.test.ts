import { describe, expect, it } from 'vitest'
import {
  createKoiosProvider,
  type FetchLike,
  type KoiosConfig,
  type RetryEvent,
} from '../../src/providers/koios/index.js'
import {
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../../src/domain/errors.js'

const BASE = 'https://preprod.koios.rest/api/v1'
const DREP = 'drep1ygpuetneftlmufa97hm5mf3xvqpdkyw656hyg6h20qaewtg3csnkc'

/** One scripted upstream answer: a body to serve, or a failure to raise. */
type Answer =
  { body: unknown } | { status: number; text?: string } | { throws: Error } | { invalidJson: true }

/** Answers per Koios path, each served in order. */
type Script = Record<string, Answer[]>

/**
 * Serves each path's answers in order, one per call to that path, repeating the last one
 * forever. That is what makes an intermittently-bad instance expressible: `[offSpec, good]` is a
 * request that fails once and succeeds on the retry, which is the whole scenario under test.
 *
 * Answers are tracked per path, not globally, because a single provider method can call more
 * than one endpoint and can call them concurrently (getDrepInfo hits /drep_info and
 * /drep_metadata at once). A global counter would hand a path whichever answer happened to be
 * next, which is a race, and would count another endpoint's calls as retries of this one.
 */
function scriptedFetch(script: Script): {
  fetchImpl: FetchLike
  callsTo: (path: string) => number
} {
  const calls: string[] = []
  const served = new Map<string, number>()

  const fetchImpl: FetchLike = async (url) => {
    calls.push(url)
    const path = Object.keys(script).find((p) => url.includes(p))
    if (path === undefined) throw new Error(`test script has no answer for ${url}`)

    const answers = script[path] as Answer[]
    const nth = served.get(path) ?? 0
    served.set(path, nth + 1)
    const answer = answers[Math.min(nth, answers.length - 1)] as Answer

    if ('throws' in answer) throw answer.throws
    if ('status' in answer) {
      return {
        ok: false,
        status: answer.status,
        json: async () => ({}),
        text: async () => answer.text ?? 'upstream said no',
      }
    }
    if ('invalidJson' in answer) {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON')
        },
        text: async () => '<html>502</html>',
      }
    }
    return { ok: true, status: 200, json: async () => answer.body, text: async () => '' }
  }

  return { fetchImpl, callsTo: (path) => calls.filter((url) => url.includes(path)).length }
}

/** A well-formed /drep_info row. */
function drepRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    drep_id: DREP,
    hex: '03ccae794affbe27a5f5f74da6266002db11daa6ae446aea783b972d',
    has_script: false,
    drep_status: 'registered',
    active: true,
    deposit: '500000000',
    amount: '820331766436',
    expires_epoch_no: 219,
    meta_url: null,
    meta_hash: null,
    ...overrides,
  }
}

/** A tip row, for the simplest possible GET read. */
const TIP_ROW = {
  hash: 'aa11',
  epoch_no: 199,
  abs_slot: 86_400_123,
  block_no: 3_500_000,
  block_time: 1_700_000_000,
}

// The delays are collected rather than awaited, so the backoff is asserted without a test
// actually sleeping through it.
function testProvider(script: Script, config: Partial<KoiosConfig> = {}) {
  const { fetchImpl, callsTo } = scriptedFetch(script)
  const delays: number[] = []
  const retries: RetryEvent[] = []
  const provider = createKoiosProvider({
    baseUrl: BASE,
    fetchImpl,
    delayImpl: async (ms) => {
      delays.push(ms)
    },
    onRetry: (event) => retries.push(event),
    ...config,
  })
  return { provider, callsTo, delays, retries }
}

describe('koios read attempt configuration', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s budget at construction', (_case, readAttempts) => {
    expect(() => testProvider({}, { readAttempts })).toThrow(
      new RangeError('readAttempts must be a positive safe integer; use 1 to disable retries'),
    )
  })

  it.each([1, Number.MAX_SAFE_INTEGER])(
    'accepts the positive safe-integer boundary %s',
    async (readAttempts) => {
      const { provider, callsTo } = testProvider(
        { '/tip': [{ body: [TIP_ROW] }] },
        { readAttempts },
      )

      await expect(provider.getTip()).resolves.toMatchObject({ block: 3_500_000 })
      expect(callsTo('/tip')).toBe(1)
    },
  )
})

describe('koios read retry', () => {
  // The case this whole mechanism exists for. Koios serves `active: null` from some instances
  // (koios-artifacts#411), which is a 200 carrying well-formed JSON of the wrong shape: it only
  // fails at the schema, after the fetch has already succeeded. A retry wrapped around the fetch
  // alone would never see it.
  it('rescues a read whose body is off-spec, and returns the good response', async () => {
    const { provider, callsTo, retries } = testProvider({
      '/drep_info': [{ body: [drepRow({ active: null })] }, { body: [drepRow()] }],
      '/drep_metadata': [{ body: [] }],
    })

    const [drep] = await provider.getDrepInfo([DREP])

    expect(drep?.active).toBe(true)
    expect(callsTo('/drep_info')).toBe(2)
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({ path: '/drep_info', attempt: 1, code: 'UPSTREAM_MALFORMED' })
  })

  it('gives up after the attempt budget and surfaces the upstream error', async () => {
    const { provider, callsTo, retries } = testProvider({
      '/drep_info': [{ body: [drepRow({ active: null })] }],
      '/drep_metadata': [{ body: [] }],
    })

    await expect(provider.getDrepInfo([DREP])).rejects.toBeInstanceOf(MalformedUpstreamError)

    // Three attempts, so two retries: an upstream that is genuinely broken surfaces as broken
    // rather than being retried forever.
    expect(callsTo('/drep_info')).toBe(3)
    expect(retries.map((r) => r.attempt)).toEqual([1, 2])
  })

  it('retries a 5xx, a transport failure, invalid json, and a timeout', async () => {
    const transient: Answer[] = [
      { status: 503 },
      { throws: new TypeError('fetch failed') },
      { invalidJson: true },
      { throws: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) },
    ]

    for (const bad of transient) {
      const { provider, callsTo } = testProvider({ '/tip': [bad, { body: [TIP_ROW] }] })

      await expect(provider.getTip()).resolves.toMatchObject({ epoch: 199 })

      expect(callsTo('/tip')).toBe(2)
    }
  })

  // The one class of failure that must not be retried. A 413 (an oversized batch body) or a 400
  // (a bad filter) is our own request being wrong: every instance rejects it identically, so a
  // retry only multiplies the load and delays the error the caller needs to see.
  it('does not retry a 4xx', async () => {
    for (const status of [400, 404, 413, 429]) {
      const { provider, callsTo, retries } = testProvider({ '/tip': [{ status }] })

      await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderError)

      expect(callsTo('/tip')).toBe(1)
      expect(retries).toHaveLength(0)
    }
  })

  // The line that must never be softened. A transaction that actually landed, resent because the
  // response to the first attempt was garbled, is a double-spend. submit() does not go through
  // the retry path at all, so this is structural rather than a policy someone has to remember.
  it('never retries a submit, whatever the failure', async () => {
    const failures: Answer[] = [
      { status: 503 },
      { invalidJson: true },
      { throws: new TypeError('fetch failed') },
      { throws: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) },
    ]

    for (const failure of failures) {
      const { provider, callsTo, retries } = testProvider({ '/submittx': [failure] })

      await expect(provider.submitTx('deadbeef')).rejects.toBeInstanceOf(Error)

      expect(callsTo('/submittx')).toBe(1)
      expect(retries).toHaveLength(0)
    }
  })

  it('backs off linearly between attempts', async () => {
    const { provider, delays } = testProvider(
      { '/tip': [{ status: 503 }] },
      { retryBackoffMs: 100 },
    )

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderError)

    expect(delays).toEqual([100, 200])
  })

  it('honours a raised attempt budget', async () => {
    const { provider, callsTo } = testProvider({ '/tip': [{ status: 503 }] }, { readAttempts: 5 })

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderError)

    expect(callsTo('/tip')).toBe(5)
  })

  it('makes exactly one attempt when retrying is disabled', async () => {
    const { provider, callsTo, retries } = testProvider(
      { '/tip': [{ status: 503 }] },
      { readAttempts: 1 },
    )

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderError)

    expect(callsTo('/tip')).toBe(1)
    expect(retries).toHaveLength(0)
  })

  it('surfaces a timeout as a timeout once the budget is spent', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const { provider, callsTo } = testProvider({ '/tip': [{ throws: timeout }] })

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderTimeoutError)

    expect(callsTo('/tip')).toBe(3)
  })

  // A batch read is a POST on the wire, which is exactly why the read/write split is a method
  // rather than a guess at the HTTP verb: this must be retried, and a submit must not be.
  it('retries a batch read', async () => {
    const { provider, callsTo } = testProvider({
      '/address_info': [{ status: 503 }, { body: [{ address: 'addr_test1aaa' }] }],
    })

    await expect(provider.filterUsedAddresses(['addr_test1aaa', 'addr_test1bbb'])).resolves.toEqual(
      ['addr_test1aaa'],
    )

    expect(callsTo('/address_info')).toBe(2)
  })

  // A read fixed on one path does not consume another path's budget: the pool list walks pages
  // and hydrates, and a wobble in the hydration must not be charged to the walk.
  it('retries each endpoint on its own budget', async () => {
    const { provider, callsTo } = testProvider({
      '/pool_list': [{ body: [] }],
      '/pool_info': [{ status: 503 }, { body: [] }],
    })

    await expect(provider.getPoolInfo(['pool1abc'])).resolves.toEqual([])

    expect(callsTo('/pool_info')).toBe(2)
    expect(callsTo('/pool_list')).toBe(0)
  })
})
