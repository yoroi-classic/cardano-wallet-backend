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

describe('blockfrost addresses — bounded fan-out', () => {
  it('caps concurrency, preserves order, and drains every 404 body on a full-size request', async () => {
    const SIZE = 1000
    const prefix = `${BASE}/addresses/addr_test1q`
    const addresses = Array.from({ length: SIZE }, (_, i) => `addr_test1q${i}`)
    const isUsed = (i: number): boolean => i % 2 === 0

    let inFlight = 0
    let maxInFlight = 0
    // One marker per 404 answer, flipped to `read: true` only when the client consumes its body.
    // If any stays false the driver left a response body unread, which is the connection-pool leak
    // this guards against.
    const notFoundBodies: { read: boolean }[] = []

    const fetchImpl: FetchLike = async (url) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      // Yield so overlapping calls actually overlap: without a turn of the event loop every call
      // would resolve before the next began and maxInFlight would read 1 no matter the ceiling.
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1

      const index = Number(url.slice(prefix.length))
      if (isUsed(index)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ address: addresses[index] }),
          text: async () => '',
        }
      }
      const body = { read: false }
      notFoundBodies.push(body)
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => {
          body.read = true
          return ''
        },
      }
    }
    // A burst larger than the batch keeps the rate limiter out of the way: this test is about the
    // concurrency ceiling and body draining, not pacing (that is covered separately with an
    // injected clock), and pacing under real timers would make it needlessly slow.
    const provider = createBlockfrostProvider({
      baseUrl: BASE,
      projectId: PROJECT_ID,
      fetchImpl,
      burstSize: SIZE + 1,
    })

    const result = await provider.filterUsedAddresses(addresses)

    // Order preserved: exactly the used addresses, in input order.
    expect(result).toEqual(addresses.filter((_address, i) => isUsed(i)))
    // The ceiling is respected: never all 1000 at once, but genuinely overlapping.
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(10)
    // Every 404 body was drained.
    expect(notFoundBodies).toHaveLength(SIZE / 2)
    expect(notFoundBodies.every((b) => b.read)).toBe(true)
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
