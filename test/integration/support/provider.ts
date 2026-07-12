import { createKoiosProvider } from '../../../src/providers/koios/index.js'

/**
 * Shared setup for the live integration suite. Each area gets its own
 * `<area>.integration.test.ts` file so a new capability adds a file here rather than
 * appending to one shared suite that every concurrent branch would collide on.
 *
 * These hit real preprod Koios and run only in the preprod and main gates, never in the
 * default unit run. The public free tier is enough, so no token is required.
 */
// Trailing slashes are stripped for the same reason the provider client strips them: a
// configured KOIOS_URL ending in `/` would otherwise build `/api/v1//pool_list`.
export const KOIOS_BASE_URL = (
  process.env.KOIOS_URL ?? 'https://preprod.koios.rest/api/v1'
).replace(/\/+$/, '')

// Discovery is a plain index read, but it runs before the behavior under test, so it gets
// a longer leash than the provider's own 10s: a slow-but-working Koios should fail the
// assertion, not the setup.
const DISCOVERY_TIMEOUT_MS = 15_000

export function integrationProvider() {
  return createKoiosProvider({ baseUrl: KOIOS_BASE_URL, token: process.env.KOIOS_TOKEN })
}

/**
 * Query Koios directly, for the tests that first have to *discover* a live fixture (a
 * currently-registered pool, a reward account with real history) so they can't rot when a
 * hardcoded one retires.
 *
 * Carries the same token the provider does, and its own bounded timeout. A bare `fetch`
 * would carry neither, so the discovery step could exhaust the anonymous rate limit and
 * fail the test before it ever reached the behavior under test, even with KOIOS_TOKEN set.
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
