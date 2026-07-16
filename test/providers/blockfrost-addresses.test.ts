import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { MalformedUpstreamError, ProviderError } from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'

const USED = 'addr_test1qUsedAddress'
const UNUSED = 'addr_test1qUnusedAddress'
const ERRORS = 'addr_test1qErrorsAddress'

function testProvider(byAddress: Record<string, { status: number } | { address: string }>) {
  const fetchImpl: FetchLike = async (url) => {
    const address = Object.keys(byAddress).find((a) => url.endsWith(encodeURIComponent(a)))
    if (address === undefined) throw new Error(`test script has no answer for ${url}`)
    const answer = byAddress[address] as { status: number } | { address: string }
    if ('status' in answer) {
      return {
        ok: answer.status < 400,
        status: answer.status,
        json: async () => ({}),
        text: async () => '',
      }
    }
    return { ok: true, status: 200, json: async () => answer, text: async () => '' }
  }
  return createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })
}

describe('blockfrost addresses — happy path', () => {
  it('filters to only the addresses that have appeared on chain, preserving order', async () => {
    const provider = testProvider({
      [USED]: { address: USED },
      [UNUSED]: { status: 404 },
    })

    const result = await provider.filterUsedAddresses([UNUSED, USED])

    expect(result).toEqual([USED])
  })

  it('returns an empty array without calling upstream for an empty input', async () => {
    let called = false
    const fetchImpl: FetchLike = async () => {
      called = true
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.filterUsedAddresses([])).resolves.toEqual([])
    expect(called).toBe(false)
  })
})

describe('blockfrost addresses — unhappy path', () => {
  it('surfaces a non-404 upstream error rather than treating it as unused', async () => {
    const provider = testProvider({ [ERRORS]: { status: 500 } })

    await expect(provider.filterUsedAddresses([ERRORS])).rejects.toBeInstanceOf(ProviderError)
  })

  it('throws MalformedUpstreamError when a 200 response is not the expected shape', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: 'object' }),
      text: async () => '',
    })
    const provider = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(provider.filterUsedAddresses([USED])).rejects.toBeInstanceOf(
      MalformedUpstreamError,
    )
  })
})
