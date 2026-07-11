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

export function integrationProvider() {
  return createKoiosProvider({ baseUrl: KOIOS_BASE_URL, token: process.env.KOIOS_TOKEN })
}
