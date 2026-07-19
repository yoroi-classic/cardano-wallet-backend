import { createBlockfrostProvider } from '../../../src/providers/blockfrost/index.js'

/**
 * Shared setup for the live Blockfrost integration suite, mirroring `support/provider.ts` for
 * Koios. These would hit real preprod Blockfrost and run only in the preprod and main CI gates,
 * never the default unit run.
 *
 * Unlike Koios, Blockfrost has no public free tier: every request needs a `project_id`, and none
 * is provisioned for this project yet (see issue #4's status comment). Every test in this suite
 * guards on `BLOCKFROST_PROJECT_ID` with `it.skipIf` and skips itself when it is unset, rather
 * than failing a gate on a credential nobody has issued. Provisioning one is a follow-up.
 */
export const BLOCKFROST_BASE_URL = (
  process.env.BLOCKFROST_URL ?? 'https://cardano-preprod.blockfrost.io/api/v0'
).replace(/\/+$/, '')

export const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID

export function integrationProvider() {
  if (BLOCKFROST_PROJECT_ID === undefined) {
    throw new Error('BLOCKFROST_PROJECT_ID is not set; this test should have been skipped')
  }
  return createBlockfrostProvider({
    baseUrl: BLOCKFROST_BASE_URL,
    projectId: BLOCKFROST_PROJECT_ID,
  })
}

// Discovery is a plain resource read, but it runs before the behavior under test, so it gets a
// longer leash than the provider's own default: a slow-but-working Blockfrost should fail the
// assertion, not the setup.
const DISCOVERY_TIMEOUT_MS = 15_000

/**
 * Query Blockfrost directly, for the tests that first have to *discover* a live fixture (a
 * currently-registered pool's reward account, say) so they can't rot when a hardcoded one
 * retires. Carries the same project id the provider does and its own bounded timeout, the same
 * reason the Koios support helper's `discover` exists.
 */
export async function discover<T>(path: string): Promise<T> {
  if (BLOCKFROST_PROJECT_ID === undefined) {
    throw new Error('BLOCKFROST_PROJECT_ID is not set; this test should have been skipped')
  }
  const res = await fetch(`${BLOCKFROST_BASE_URL}${path}`, {
    headers: { accept: 'application/json', project_id: BLOCKFROST_PROJECT_ID },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`blockfrost discovery failed with ${res.status} for ${path}`)
  }
  return (await res.json()) as T
}
