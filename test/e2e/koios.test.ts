import { describe, expect, it, vi } from 'vitest'
import { discoverRegisteredPoolId, type PoolListFetch } from '../../e2e/src/koios.js'

const BASE_WITH_CREDENTIALS = 'https://user:password@example.test/api/v1'
const SECRET_BODY = 'proxy diagnostic secret=do-not-log'

describe('E2E Koios pool discovery', () => {
  it.each([404, 429, 500])(
    'surfaces HTTP %s before consuming or logging the response body',
    async (status) => {
      const json = vi.fn(async () => {
        throw new Error('JSON must not be consumed for an HTTP failure')
      })
      const text = vi.fn(async () => SECRET_BODY)
      const fetchImpl: PoolListFetch = vi.fn(async () => ({
        ok: false,
        status,
        json,
        text,
      }))

      let message = ''
      try {
        await discoverRegisteredPoolId(BASE_WITH_CREDENTIALS, fetchImpl)
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }

      expect(message).toBe(`Koios pool_list returned HTTP ${status}`)
      expect(message).not.toContain(SECRET_BODY)
      expect(message).not.toContain('password')
      expect(json).not.toHaveBeenCalled()
      expect(text).not.toHaveBeenCalled()
    },
  )

  it('sanitizes a malformed JSON error instead of echoing response content', async () => {
    const fetchImpl: PoolListFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError(`Unexpected token in ${SECRET_BODY}`)
      },
    })

    await expect(discoverRegisteredPoolId(BASE_WITH_CREDENTIALS, fetchImpl)).rejects.toThrow(
      'Koios pool_list returned malformed JSON',
    )
    await expect(discoverRegisteredPoolId(BASE_WITH_CREDENTIALS, fetchImpl)).rejects.not.toThrow(
      SECRET_BODY,
    )
  })

  it.each(['AbortError', 'TimeoutError'])(
    'preserves a %s raised while streaming the JSON body',
    async (name) => {
      const bodyReadFailure = Object.assign(new Error('response body stopped'), { name })
      const fetchImpl: PoolListFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw bodyReadFailure
        },
      })

      await expect(
        discoverRegisteredPoolId('https://user:password@example.test/api/v1', fetchImpl),
      ).rejects.toBe(bodyReadFailure)
      expect(bodyReadFailure.message).not.toContain('password')
      expect(bodyReadFailure.message).not.toContain(SECRET_BODY)
    },
  )

  it('preserves fetch timeout failures and the 20-second discovery budget', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const signal = AbortSignal.abort()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
    const fetchImpl: PoolListFetch = async () => {
      throw timeout
    }

    await expect(discoverRegisteredPoolId('https://example.test/api/v1', fetchImpl)).rejects.toBe(
      timeout,
    )
    expect(timeoutSpy).toHaveBeenCalledWith(20_000)
    timeoutSpy.mockRestore()
  })

  it('reports an empty successful list as missing pool discovery data', async () => {
    const fetchImpl: PoolListFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    })

    await expect(
      discoverRegisteredPoolId('https://example.test/api/v1', fetchImpl),
    ).rejects.toThrow('could not find a registered pool on-chain to exercise pool info')
  })

  it('returns the discovered pool id from a successful response', async () => {
    const fetchImpl: PoolListFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => [{ pool_id_bech32: 'pool1example' }],
    })

    await expect(discoverRegisteredPoolId('https://example.test/api/v1/', fetchImpl)).resolves.toBe(
      'pool1example',
    )
  })
})
