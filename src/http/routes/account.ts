import type { FastifyInstance } from 'fastify'
import { bech32 } from '@scure/base'
import { BadRequestError } from '../../domain/errors.js'
import type { ChainProvider } from '../../providers/provider.js'

// Stake addresses use a longer payload than the default bech32 length limit.
const BECH32_LIMIT = 1023
const STAKE_PREFIXES = new Set(['stake', 'stake_test'])

// Decode the address and verify it's a well-formed bech32 stake address (valid charset
// and checksum, stake HRP), so a malformed value is rejected rather than quietly
// treated as an unknown zero-balance account.
function assertStakeAddress(value: string): string {
  const decoded = bech32.decodeUnsafe(value, BECH32_LIMIT)
  if (!decoded || !STAKE_PREFIXES.has(decoded.prefix)) {
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

  app.get('/v1/account/:stake/txs', async (request) => {
    const { stake } = request.params as { stake: string }
    const { after } = request.query as { after?: string }
    let afterBlock: number | undefined
    if (after !== undefined) {
      // Digits only, so an empty or malformed cursor is a 400 rather than a silent page 0.
      if (!/^\d+$/.test(after)) {
        throw new BadRequestError('after must be a non-negative block height')
      }
      afterBlock = Number(after)
    }
    return provider.getTxHistory(assertStakeAddress(stake), afterBlock)
  })
}
