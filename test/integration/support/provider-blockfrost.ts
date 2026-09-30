import { createBlockfrostProvider } from '../../../src/providers/blockfrost/index.js'

/**
 * Shared setup for the live Blockfrost integration suite, mirroring `support/provider.ts` for
 * Koios. These would hit real preprod Blockfrost and run only in the preprod and main CI gates,
 * never the default unit run.
 *
 * Unlike Koios, Blockfrost has no public free tier: every request needs a `project_id`. Every test
 * in this suite guards on `BLOCKFROST_PROJECT_ID` with `it.skipIf` and skips itself when it is
 * unset, so the suite is silent rather than red wherever the credential is absent.
 *
 * That silence is expensive, and it is worth knowing what it cost. While this suite skipped, the
 * DRep credential schema drifted out of step with what Blockfrost actually returns and the whole
 * governance surface answered 502 on that provider, with every unit test passing. Skipping is the
 * right behavior for a missing credential and it is not the same thing as coverage.
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
  let res: Response
  try {
    res = await fetch(`${BLOCKFROST_BASE_URL}${path}`, {
      headers: { accept: 'application/json', project_id: BLOCKFROST_PROJECT_ID },
      // Match the production Blockfrost client: native fetch otherwise forwards this custom
      // credential header when a configured endpoint redirects to another origin.
      redirect: 'error',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
  } catch {
    // Do not expose the configured URL, redirect target, credential, or native fetch details in CI.
    throw new Error(`blockfrost discovery request failed for ${path}`)
  }
  if (!res.ok) {
    throw new Error(`blockfrost discovery failed with ${res.status} for ${path}`)
  }
  return (await res.json()) as T
}

/**
 * A stake address that certainly exists on chain right now: the reward account of a currently
 * registered pool.
 *
 * Discovered rather than hardcoded, so the suite cannot rot when a pool retires. It takes two
 * reads because Blockfrost splits the fields: `/pools/extended` lists pool ids and stake figures
 * but carries no reward account, and only the per-pool resource has one. Koios puts both on its
 * own extended list, and a test written from that shape reads `reward_account` off the list here,
 * gets `undefined`, and asks Blockfrost about `/accounts/undefined/...`, which is a 400 that looks
 * like a provider fault rather than a test fault.
 */
export async function discoverRewardAddress(): Promise<string> {
  const [pool] = await discover<{ pool_id: string }[]>('/pools/extended?count=1&page=1')
  if (pool === undefined) {
    throw new Error('blockfrost discovery returned no registered pools')
  }
  const detail = await discover<{ reward_account?: string }>(
    `/pools/${encodeURIComponent(pool.pool_id)}`,
  )
  const rewardAccount = detail.reward_account
  if (typeof rewardAccount !== 'string' || rewardAccount.length === 0) {
    throw new Error('blockfrost pool detail carried no reward_account')
  }
  return rewardAccount
}

// How far back to walk when looking for a block that carries transactions. Preprod is quiet
// enough that most blocks are empty, so a handful of steps is not unusual and a bound well past
// that distinguishes "quiet chain" from "something is wrong".
const RECENT_BLOCK_SCAN = 40

/**
 * The hash of a transaction in a recent block.
 *
 * Walks back from the tip until it finds a block that carries one, because the tip block usually
 * does not. Measured on preprod on 2026-09-09: ten of the fifteen blocks below the tip were empty,
 * so a test that reads `/blocks/latest/txs` and asserts it is non-empty fails about two runs in
 * three. That is a property of a quiet testnet rather than of the code under test, and it is the
 * kind of flake that only shows up once the suite actually runs.
 */
export async function discoverRecentTxHash(): Promise<string> {
  const tip = await discover<{ height: number }>('/blocks/latest')
  for (let back = 0; back < RECENT_BLOCK_SCAN; back += 1) {
    const hashes = await discover<string[]>(`/blocks/${tip.height - back}/txs`)
    // Newest first within the block, so the freshest candidates are tried before older ones.
    for (const hash of [...hashes].reverse()) {
      const utxos = await discover<{ outputs: { consumed_by_tx?: string | null }[] }>(
        `/txs/${encodeURIComponent(hash)}/utxos`,
      )
      // The caller resolves this transaction's first output and expects it to be unspent, so one
      // whose first output has already been consumed is no use even though the transaction exists.
      // A recent output is usually unspent and occasionally is not, which is the kind of "usually"
      // that fails one run in ten rather than never.
      const first = utxos.outputs[0]
      if (first !== undefined && (first.consumed_by_tx ?? null) === null) return hash
    }
  }
  throw new Error(
    `no transaction with an unspent first output in the ${RECENT_BLOCK_SCAN} blocks below the preprod tip`,
  )
}
