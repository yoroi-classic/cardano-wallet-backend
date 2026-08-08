import type { FastifyInstance } from 'fastify'
import { BadRequestError } from '../../domain/errors.js'
import { isStakeAddressForNetwork } from '../../domain/stake-address.js'
import type { ChainProvider } from '../../providers/provider.js'

function assertStakeAddress(value: string, network: string): string {
  if (!isStakeAddressForNetwork(value, network)) {
    throw new BadRequestError('invalid stake address')
  }
  return value
}

/**
 * Account-level reads keyed by stake address. Handlers validate the address at the
 * boundary, then hand off to the provider and return the normalized shape.
 */
export function registerAccountRoutes(
  app: FastifyInstance,
  provider: ChainProvider,
  network: string,
): void {
  app.get('/v1/account/:stake/state', async (request) => {
    const { stake } = request.params as { stake: string }
    return provider.getAccountState(assertStakeAddress(stake, network))
  })

  app.get('/v1/account/:stake/utxos', async (request) => {
    const { stake } = request.params as { stake: string }
    return provider.getAccountUtxos(assertStakeAddress(stake, network))
  })

  app.get('/v1/account/:stake/txs', async (request) => {
    const { stake } = request.params as { stake: string }
    const { after } = request.query as { after?: string }
    let afterBlock: number | undefined
    if (after !== undefined) {
      // Digits only and within safe-integer range, so an empty, malformed, or absurdly
      // large cursor is a 400 rather than a silent page 0 or a rounded block height.
      const n = Number(after)
      if (!/^\d+$/.test(after) || !Number.isSafeInteger(n)) {
        throw new BadRequestError('after must be a non-negative block height')
      }
      afterBlock = n
    }
    return provider.getTxHistory(assertStakeAddress(stake, network), afterBlock)
  })

  /**
   * Every reward the account has earned, oldest first. This is the rewards graph.
   *
   * Replaces the extension's `POST /api/account/rewardHistory`.
   *
   * `after` pages forward on the epoch the reward was **earned for**, not the epoch it became
   * spendable. Cardano pays two epochs in arrears, so the two differ by ten days, and paging on
   * the wrong one shifts every point on the graph by that much while still looking plausible.
   */
  app.get('/v1/account/:stake/rewards', async (request) => {
    const { stake } = request.params as { stake: string }
    const { after } = request.query as { after?: string }

    let afterEpoch: number | undefined
    if (after !== undefined) {
      const n = Number(after)
      if (!/^\d+$/.test(after) || !Number.isSafeInteger(n)) {
        throw new BadRequestError('after must be a non-negative epoch number')
      }
      afterEpoch = n
    }

    return provider.getRewardHistory(assertStakeAddress(stake, network), afterEpoch)
  })
}
