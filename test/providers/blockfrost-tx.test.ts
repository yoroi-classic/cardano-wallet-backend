import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { BadRequestError, MalformedUpstreamError, ProviderError } from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'
const TX_HASH = '1e043f100dce12d107f679685acd2fc0610e10f72a92d412794c9773d11d8477'
const BLOCK_HASH = '356b7d7dbb696ccd12775c016941057a9dc70898d87a63fc752271bb46856940'

/** Scripts one JSON response per call to a given path, repeating the last one after that. */
function scriptedFetch(script: Record<string, unknown[]>): {
  fetchImpl: FetchLike
  callsTo: (path: string) => number
} {
  const calls: string[] = []
  const served = new Map<string, number>()
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url)
    const path = Object.keys(script).find((p) => url.includes(p))
    if (path === undefined) throw new Error(`test script has no answer for ${url}`)
    const answers = script[path] as unknown[]
    const nth = served.get(path) ?? 0
    served.set(path, nth + 1)
    const answer = answers[Math.min(nth, answers.length - 1)]
    if (answer && typeof answer === 'object' && !Array.isArray(answer) && 'status' in answer) {
      const a = answer as { status: number; text?: string }
      return {
        ok: a.status < 400,
        status: a.status,
        json: async () => ({}),
        text: async () => a.text ?? '',
      }
    }
    return { ok: true, status: 200, json: async () => answer, text: async () => '' }
  }
  return { fetchImpl, callsTo: (path) => calls.filter((url) => url.includes(path)).length }
}

function testProvider(script: Record<string, unknown[]>) {
  const { fetchImpl, callsTo } = scriptedFetch(script)
  const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })
  return { provider, callsTo }
}

describe('blockfrost tx — happy path', () => {
  it('submitTx sends raw CBOR bytes and returns the bare-string tx hash', async () => {
    const { provider } = testProvider({ '/tx/submit': [TX_HASH] })

    const result = await provider.submitTx('deadbeef')

    expect(result).toEqual({ txHash: TX_HASH })
  })

  it('getTxStatus reports seen and the block confirmation depth', async () => {
    const { provider } = testProvider({
      [`/txs/${TX_HASH}`]: [{ block: BLOCK_HASH }],
      [`/blocks/${BLOCK_HASH}`]: [{ confirmations: 4698 }],
    })

    const status = await provider.getTxStatus(TX_HASH)

    expect(status).toEqual({ seen: true, confirmations: 4698 })
  })

  it('getTxStatus reports unseen for a transaction not yet on chain, without calling /blocks', async () => {
    const { provider, callsTo } = testProvider({ [`/txs/${TX_HASH}`]: [{ status: 404 }] })

    await expect(provider.getTxStatus(TX_HASH)).resolves.toEqual({ seen: false, confirmations: 0 })
    expect(callsTo('/blocks/')).toBe(0)
  })
})

describe('blockfrost tx — unhappy path', () => {
  it('rejects a non-hex submitTx payload before making any request', async () => {
    const { provider, callsTo } = testProvider({ '/tx/submit': [TX_HASH] })

    await expect(provider.submitTx('not-hex!!')).rejects.toBeInstanceOf(BadRequestError)
    expect(callsTo('/tx/submit')).toBe(0)
  })

  it('rejects an odd-length hex submitTx payload', async () => {
    const { provider } = testProvider({ '/tx/submit': [TX_HASH] })

    await expect(provider.submitTx('abc')).rejects.toBeInstanceOf(BadRequestError)
  })

  it('never retries a submit, whatever the failure', async () => {
    const { provider, callsTo } = testProvider({ '/tx/submit': [{ status: 503 }] })

    await expect(provider.submitTx('deadbeef')).rejects.toBeInstanceOf(ProviderError)
    expect(callsTo('/tx/submit')).toBe(1)
  })

  it('throws MalformedUpstreamError when the submit response is not a bare tx hash', async () => {
    const { provider } = testProvider({ '/tx/submit': [{ not: 'a tx hash' }] })

    await expect(provider.submitTx('deadbeef')).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('surfaces a non-404 upstream error from getTxStatus', async () => {
    const { provider } = testProvider({ [`/txs/${TX_HASH}`]: [{ status: 500 }] })

    await expect(provider.getTxStatus(TX_HASH)).rejects.toBeInstanceOf(ProviderError)
  })
})
