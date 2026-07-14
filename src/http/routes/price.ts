import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { BadRequestError, NotImplementedError } from '../../domain/errors.js'
import { PRICE_WINDOWS } from '../../domain/types/price.js'

/**
 * The price surface: reserved, validated, documented, and not yet implemented.
 *
 * ## Why a stub rather than nothing
 *
 * The clients are being ported onto this API now. If the price endpoints simply did not exist,
 * every adapter would have to keep a branch for "the old Emurgo host" purely for price, and that
 * branch would outlive the migration by however long it takes us to pick a provider. Reserving
 * the paths means an adapter can be written against its final shape today and start working the
 * day we wire a provider behind it, with no client change.
 *
 * ## Why 501 and not a fake number
 *
 * These endpoints validate the request properly and then answer `501 NOT_IMPLEMENTED`. They do
 * **not** return a price of zero, or null, or a placeholder.
 *
 * That is the whole point. A wallet that receives `0` renders a portfolio worth $0.00, and a user
 * looking at that has no way to tell "the market crashed" from "the backend has not been built".
 * One of those is a reason to panic-sell. A 501 is unambiguous, and a client can render "price
 * unavailable", which is both true and harmless. **Never invent a number a user might act on.**
 *
 * ## Why there is nothing to implement yet
 *
 * Price is the one domain here with no on-chain source. The chain does not know what ADA is worth
 * in dollars; that fact lives in markets. So this needs a real market-data provider (CoinGecko
 * for ADA fiat, GeckoTerminal or a Cardano DEX aggregator for the long-tail native tokens), and
 * choosing one is a decision about cost, licensing and who we are willing to depend on. See #6.
 */

const currencyCode = z.string().regex(/^[A-Za-z]{2,10}$/)

const adaQuery = z.object({
  // A comma-separated list, e.g. `?currencies=USD,EUR,JPY`.
  currencies: z
    .string()
    .transform((raw) => raw.split(',').map((c) => c.trim().toUpperCase()))
    .pipe(z.array(currencyCode).min(1).max(20)),
})

const RANGES = ['1d', '1w', '1m', '6m', '1y', 'all'] as const

const historyQuery = z.object({
  range: z.enum(RANGES).default('1m'),
  currency: currencyCode.default('USD'),
})

const activityBody = z.object({
  subjects: z.array(z.string().min(1)).min(1).max(100),
  window: z.enum(PRICE_WINDOWS).default('24h'),
})

const tokenHistoryBody = z.object({
  subject: z.string().min(1),
  range: z.enum(RANGES).default('1m'),
})

/**
 * Price and market data. Every route here answers 501 for now; see the note above.
 *
 * The request is still validated before the 501, deliberately. A client integrating against this
 * gets told immediately that it is sending the wrong shape, rather than discovering it months
 * later on the day we turn the feature on, when the 501 it had been coding around silently
 * becomes a 400.
 */
export function registerPriceRoutes(app: FastifyInstance): void {
  const notImplemented = (what: string): never => {
    throw new NotImplementedError(
      `${what} is not implemented yet: this service has no market data provider wired. ` +
        'The route and its response shape are final; see /v1/openapi.json. Do not treat this as ' +
        'a price of zero.',
    )
  }

  // Replaces the extension's `GET /api/price/{ticker}/current`.
  app.get('/v1/price/ada', async (request) => {
    const parsed = adaQuery.safeParse(request.query)
    if (!parsed.success) {
      throw new BadRequestError('query must be currencies=USD,EUR (1 to 20 currency codes)')
    }
    return notImplemented('ADA price')
  })

  // Replaces the extension's `GET /api/price/{ticker}/{timestamps}`, which is what puts a fiat
  // value on a transaction in someone's history.
  app.get('/v1/price/ada/history', async (request) => {
    const parsed = historyQuery.safeParse(request.query)
    if (!parsed.success) {
      throw new BadRequestError(`query must be range=${RANGES.join('|')} and a currency code`)
    }
    return notImplemented('ADA price history')
  })

  // Replaces the dullahan `POST /tokens/activity/multi/{window}`. This is mobile's *only* source
  // of a primary-token price, so nothing in the portfolio shows a value without it.
  app.post('/v1/price/tokens', async (request) => {
    const parsed = activityBody.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError(
        `body must be { "subjects": [...] (1 to 100), "window": "${PRICE_WINDOWS.join('" | "')}" }`,
      )
    }
    return notImplemented('token price and activity')
  })

  // Replaces the dullahan `POST /tokens/history/price`, which draws the token chart.
  app.post('/v1/price/tokens/history', async (request) => {
    const parsed = tokenHistoryBody.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError(`body must be { "subject": "...", "range": "${RANGES.join('|')}" }`)
    }
    return notImplemented('token price history')
  })
}
