import type { FastifyInstance } from 'fastify'
import { BadRequestError } from '../../domain/errors.js'
import type { ChainProvider } from '../../providers/provider.js'

// A bech32 stake address: stake1... on mainnet, stake_test1... on testnets.
const STAKE_ADDRESS = /^stake(_test)?1[0-9a-z]+$/

function assertStakeAddress(value: string): string {
  if (!STAKE_ADDRESS.test(value)) {
    throw new BadRequestError('invalid stake address')
  }
  return value
}

/**
 * Account-level reads keyed by stake address. Handlers validate the address at the
 * boundary, then hand off to the provider and return the normalized shape.
 */
export function registerAccountRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.get('/v1/account/:stake/state', async (request) => {
    const { stake } = request.params as { stake: string }
    return provider.getAccountState(assertStakeAddress(stake))
  })

  app.get('/v1/account/:stake/utxos', async (request) => {
    const { stake } = request.params as { stake: string }
    return provider.getAccountUtxos(assertStakeAddress(stake))
  })
}
