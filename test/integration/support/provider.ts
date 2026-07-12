import { createKoiosProvider } from '../../../src/providers/koios/index.js'

/**
 * Shared setup for the live integration suite. Each area gets its own
 * `<area>.integration.test.ts` file so a new capability adds a file here rather than
 * appending to one shared suite that every concurrent branch would collide on.
 *
 * These hit real preprod Koios and run only in the preprod and main gates, never in the
 * default unit run. The public free tier is enough, so no token is required.
 */
export const KOIOS_BASE_URL = process.env.KOIOS_URL ?? 'https://preprod.koios.rest/api/v1'

const DISCOVERY_TIMEOUT_MS = 15_000

export function integrationProvider() {
  return createKoiosProvider({ baseUrl: KOIOS_BASE_URL, token: process.env.KOIOS_TOKEN })
}

/**
 * Query Koios directly, for the tests that first have to *discover* a live fixture (a
 * currently-registered pool, a reward account with real history) so they can't rot when a
 * hardcoded one retires.
 *
 * Routed through the same token and timeout the provider itself uses. A bare `fetch` would
 * skip both, so the discovery step could exhaust the anonymous rate limit and fail the
 * test before it ever reached the behavior under test, even with KOIOS_TOKEN set.
 */
export async function discover<T>(path: string): Promise<T[]> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const token = process.env.KOIOS_TOKEN
  if (token) headers.authorization = `Bearer ${token}`

  const res = await fetch(`${KOIOS_BASE_URL}${path}`, {
    headers,
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`koios discovery failed with ${res.status} for ${path}`)
  }
  return (await res.json()) as T[]
}
