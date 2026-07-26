interface PoolListResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text?: () => Promise<string>
}

export type PoolListFetch = (
  input: string,
  init: { signal: AbortSignal },
) => Promise<PoolListResponse>

const DISCOVERY_TIMEOUT_MS = 20_000

/**
 * Find one live registered pool for the E2E harness to read back through `/v1`.
 *
 * This is fixture discovery rather than the behavior under test, so failures are deliberately
 * terse: status and endpoint identify an HTTP failure without copying an upstream body or a
 * credential-bearing configured URL into the E2E log.
 */
export async function discoverRegisteredPoolId(
  koiosBase: string,
  fetchImpl: PoolListFetch = globalThis.fetch,
): Promise<string> {
  const base = koiosBase.replace(/\/+$/, '')
  const res = await fetchImpl(`${base}/pool_list?pool_status=eq.registered&limit=1`, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })

  // Check status before consuming either body representation. Koios error pages are not pool
  // lists, and their contents may include proxy diagnostics that do not belong in the E2E log.
  if (!res.ok) {
    throw new Error(`Koios pool_list returned HTTP ${res.status}`)
  }

  let data: unknown
  try {
    data = await res.json()
  } catch (err) {
    // Headers can arrive before the body. If the shared timeout fires while Response.json() is
    // still streaming that body, retain the abort/timeout taxonomy rather than relabeling an
    // upstream stall as malformed JSON.
    if (
      err !== null &&
      typeof err === 'object' &&
      'name' in err &&
      (err.name === 'AbortError' || err.name === 'TimeoutError')
    ) {
      throw err
    }
    // Response.json() errors often quote the invalid body. Replace that message so logging the
    // outer E2E failure cannot echo an upstream error page or credential.
    throw new Error('Koios pool_list returned malformed JSON')
  }

  const samplePoolId =
    Array.isArray(data) && typeof data[0]?.pool_id_bech32 === 'string'
      ? data[0].pool_id_bech32
      : undefined
  if (!samplePoolId) {
    throw new Error('could not find a registered pool on-chain to exercise pool info')
  }
  return samplePoolId
}
