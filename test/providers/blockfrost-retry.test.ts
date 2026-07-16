import { describe, expect, it } from 'vitest'
import {
  createBlockfrostProvider,
  type BlockfrostConfig,
  type FetchLike,
  type RetryEvent,
} from '../../src/providers/blockfrost/index.js'
import {
  MalformedUpstreamError,
  ProviderError,
  ProviderTimeoutError,
} from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'

/** One scripted upstream answer: a body to serve, or a failure to raise. */
type Answer =
  { body: unknown } | { status: number; text?: string } | { throws: Error } | { invalidJson: true }

/** Answers per Blockfrost path, each served in order, repeating the last one forever. */
type Script = Record<string, Answer[]>

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

const TIP_ROW = {
  time: 1_700_000_000,
  height: 3_500_000,
  hash: 'aa11',
  slot: 86_400_123,
  epoch: 199,
}

function testProvider(script: Script, config: Partial<BlockfrostConfig> = {}) {
  const { fetchImpl, callsTo } = scriptedFetch(script)
  const delays: number[] = []
  const retries: RetryEvent[] = []
  const provider = createBlockfrostProvider({
    baseUrl: BASE,
    projectId: PROJECT_ID,
    fetchImpl,
    delayImpl: async (ms) => {
      delays.push(ms)
    },
    onRetry: (event) => retries.push(event),
    ...config,
  })
  return { provider, callsTo, delays, retries }
}

describe('blockfrost read retry', () => {
  it('rescues a read whose body is off-spec, and returns the good response', async () => {
    const { provider, callsTo, retries } = testProvider({
      '/blocks/latest': [{ body: { ...TIP_ROW, height: null } }, { body: TIP_ROW }],
    })

    const tip = await provider.getTip()

    expect(tip.block).toBe(3_500_000)
    expect(callsTo('/blocks/latest')).toBe(2)
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({
      path: '/blocks/latest',
      attempt: 1,
      code: 'UPSTREAM_MALFORMED',
    })
  })

  it('gives up after the attempt budget and surfaces the upstream error', async () => {
    const { provider, callsTo, retries } = testProvider({
      '/blocks/latest': [{ body: { ...TIP_ROW, height: null } }],
    })

    await expect(provider.getTip()).rejects.toBeInstanceOf(MalformedUpstreamError)

    expect(callsTo('/blocks/latest')).toBe(3)
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
      const { provider, callsTo } = testProvider({ '/blocks/latest': [bad, { body: TIP_ROW }] })

      await expect(provider.getTip()).resolves.toMatchObject({ epoch: 199 })

      expect(callsTo('/blocks/latest')).toBe(2)
    }
  })

  // The one class of failure that must not be retried, matching the Koios client's own policy: a
  // 404 or a 400 is our own request being wrong, or upstream telling us something specific and
  // final (not on chain, rate limited), and every instance answers it identically.
  it('does not retry a 4xx', async () => {
    for (const status of [400, 403, 404, 418, 429]) {
      const { provider, callsTo, retries } = testProvider({ '/blocks/latest': [{ status }] })

      await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderError)

      expect(callsTo('/blocks/latest')).toBe(1)
      expect(retries).toHaveLength(0)
    }
  })

  it('never retries a submit, whatever the failure', async () => {
    const failures: Answer[] = [
      { status: 503 },
      { invalidJson: true },
      { throws: new TypeError('fetch failed') },
      { throws: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) },
    ]

    for (const failure of failures) {
      const { provider, callsTo, retries } = testProvider({ '/tx/submit': [failure] })

      await expect(provider.submitTx('deadbeef')).rejects.toBeInstanceOf(Error)

      expect(callsTo('/tx/submit')).toBe(1)
      expect(retries).toHaveLength(0)
    }
  })

  it('backs off linearly between attempts', async () => {
    const { provider, delays } = testProvider(
      { '/blocks/latest': [{ status: 503 }] },
      { retryBackoffMs: 100 },
    )

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderError)

    expect(delays).toEqual([100, 200])
  })

  it('honours a raised attempt budget', async () => {
    const { provider, callsTo } = testProvider(
      { '/blocks/latest': [{ status: 503 }] },
      { readAttempts: 5 },
    )

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderError)

    expect(callsTo('/blocks/latest')).toBe(5)
  })

  it('makes exactly one attempt when retrying is disabled', async () => {
    const { provider, callsTo, retries } = testProvider(
      { '/blocks/latest': [{ status: 503 }] },
      { readAttempts: 1 },
    )

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderError)

    expect(callsTo('/blocks/latest')).toBe(1)
    expect(retries).toHaveLength(0)
  })

  it('surfaces a timeout as a timeout once the budget is spent', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const { provider, callsTo } = testProvider({ '/blocks/latest': [{ throws: timeout }] })

    await expect(provider.getTip()).rejects.toBeInstanceOf(ProviderTimeoutError)

    expect(callsTo('/blocks/latest')).toBe(3)
  })

  // A 404 on a getOrUndefined read is a legitimate answer, not a failure, and must not be
  // retried or surfaced as an error.
  it('treats a 404 on getOrUndefined as a clean result, not a retryable failure', async () => {
    const { provider, callsTo, retries } = testProvider({
      '/accounts/stake_test1abc': [{ status: 404 }],
    })

    await expect(provider.getAccountState('stake_test1abc')).resolves.toMatchObject({
      registered: false,
    })
    expect(callsTo('/accounts/stake_test1abc')).toBe(1)
    expect(retries).toHaveLength(0)
  })
})
