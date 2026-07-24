import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { BadRequestError } from '../../domain/errors.js'
import type { ChainProvider } from '../../providers/provider.js'

// Even-length hex (whole bytes), matching what the provider will accept.
const submitBody = z.object({ cbor: z.string().regex(/^([0-9a-fA-F]{2})+$/) })
const TX_HASH = /^[0-9a-fA-F]{64}$/

// A UTxO reference, in the form the whole ecosystem writes it: `<64 hex>#<index>`. The index is
// bounded rather than merely numeric, because a transaction cannot have 10^9 outputs and a value
// like that is a caller bug we would otherwise forward to Koios and get a 400 for from further
// away, where it is harder to understand.
const MAX_OUTPUT_INDEX = 65_535
const UTXO_REF = /^[0-9a-fA-F]{64}#\d{1,5}$/

const utxoRefsBody = z.object({
  refs: z.array(z.string()).min(1).max(100),
})

function normalizeUtxoRef(ref: string): string | undefined {
  if (!UTXO_REF.test(ref)) return undefined
  const index = Number(ref.slice(65))
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_OUTPUT_INDEX) return undefined

  // Koios keys both components canonically: lowercase hex and an ordinary base-10 integer.
  return `${ref.slice(0, 64).toLowerCase()}#${index}`
}

/** Transaction submit and status. */
export function registerTxRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.post('/v1/tx/submit', async (request) => {
    const parsed = submitBody.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError('body must be { "cbor": "<hex-encoded transaction>" }')
    }
    return provider.submitTx(parsed.data.cbor)
  })

  app.get('/v1/tx/:hash/status', async (request) => {
    const { hash } = request.params as { hash: string }
    if (!TX_HASH.test(hash)) {
      throw new BadRequestError('invalid transaction hash')
    }
    return provider.getTxStatus(hash)
  })

  /**
   * Resolve transaction outputs by reference.
   *
   * Replaces the extension's `GET /api/txs/io/{txHash}/o/{txIndex}`, and batches it: a dApp
   * connector resolving a transaction's inputs asks about all of them at once, and one call is
   * better than twenty.
   *
   * Unlike `/v1/account/{stake}/utxos`, an output here may be **spent**, and the response says
   * which. That is the point of the endpoint rather than an incidental extra field: collateral
   * has to be an unspent output, and a wallet that reuses one it set aside an hour ago without
   * re-checking builds a transaction the node rejects, leaving the user with an unexplained
   * failure.
   *
   * Never cached, for the same reason as every other account-scoped read: a stale spent flag is
   * precisely the error this endpoint exists to prevent.
   */
  app.post('/v1/tx/utxos', async (request) => {
    const parsed = utxoRefsBody.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError('body must be { "refs": ["<txHash>#<index>", ...] } (1 to 100)')
    }

    const normalizedRefs: string[] = []
    const bad: string[] = []
    for (const ref of parsed.data.refs) {
      const normalized = normalizeUtxoRef(ref)
      if (normalized === undefined) bad.push(ref)
      else normalizedRefs.push(normalized)
    }
    if (bad.length > 0) {
      throw new BadRequestError(
        `refs must be "<64-char tx hash>#<output index>": ${bad.slice(0, 3).join(', ')}`,
      )
    }

    return provider.getUtxosByRef(normalizedRefs)
  })
}
