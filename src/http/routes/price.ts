import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { BadRequestError, NotImplementedError } from '../../domain/errors.js'
import { PRICE_RANGES, PRICE_WINDOWS } from '../../domain/types/price.js'
import type { PriceProvider } from '../../prices/index.js'

/**
 * Price and market data: ADA's fiat price and history from CoinGecko, native-token price and
 * history (in ADA) from GeckoTerminal. See src/prices/index.ts for the provider.
 *
 * ## Why a route with no provider wired still answers 501, and never a fake number
 *
 * CoinGecko and GeckoTerminal need no credential at their free tier, so a real deployment always
 * has a provider (see main() in src/index.ts). The dependency stays optional here anyway, the same
 * way the NFTCDN signer is: a test can build a bare server with nothing wired, and this is where
 * that server's price routes land. They validate the request properly and then answer
 * `501 NOT_IMPLEMENTED`. They do **not** return a price of zero, or null, or a placeholder.
 *
 * That is the whole point. A wallet that receives `0` renders a portfolio worth $0.00, and a user
 * looking at that has no way to tell "the market crashed" from "the backend has not been built".
 * One of those is a reason to panic-sell. A 501 is unambiguous, and a client can render "price
 * unavailable", which is both true and harmless. **Never invent a number a user might act on.**
 *
 * The same rule holds once a provider *is* wired: an upstream failure surfaces as the honest
 * `502`/`504` this service always uses for that (`ProviderError`/`ProviderTimeoutError`), never as
 * a quote we made up because the real one didn't arrive.
 */

const currencyCode = z.string().regex(/^[A-Za-z]{2,10}$/)

const adaQuery = z.object({
  // A comma-separated list, e.g. `?currencies=USD,EUR,JPY`.
  currencies: z
    .string()
    .transform((raw) => raw.split(',').map((c) => c.trim().toUpperCase()))
    .pipe(z.array(currencyCode).min(1).max(20)),
})

const historyQuery = z.object({
  range: z.enum(PRICE_RANGES).default('1m'),
  currency: currencyCode.default('USD'),
})

const activityBody = z.object({
  subjects: z.array(z.string().min(1)).min(1).max(100),
  window: z.enum(PRICE_WINDOWS).default('24h'),
})

const tokenHistoryBody = z.object({
  subject: z.string().min(1),
  range: z.enum(PRICE_RANGES).default('1m'),
})

/**
 * Price and market data. Every route falls back to `501` when no provider is wired; see the note
 * above for why that never becomes a fake price instead.
 */
export function registerPriceRoutes(app: FastifyInstance, priceProvider?: PriceProvider): void {
  /** The provider, or the same 501 this whole surface has always answered before one existed. */
  function requireProvider(): PriceProvider {
    if (priceProvider === undefined) {
      throw new NotImplementedError(
        'price is not implemented on this deployment: no market data provider is wired. The ' +
          'route and its response shape are final; see /v1/openapi.json. Do not treat this as ' +
          'a price of zero.',
      )
    }
    return priceProvider
  }

  // Replaces the extension's `GET /api/price/{ticker}/current`.
  //
  // Validated *before* the provider is required, in every handler below, and deliberately so: a
  // client integrating against this finds out immediately that it sent the wrong shape, rather
  // than on the day a provider gets wired, when the 501 it had been coding around silently
  // becomes a 400 it never saw during development.
  app.get('/v1/price/ada', async (request) => {
    const parsed = adaQuery.safeParse(request.query)
    if (!parsed.success) {
      throw new BadRequestError('query must be currencies=USD,EUR (1 to 20 currency codes)')
    }
    return requireProvider().getAdaPrice(parsed.data.currencies)
  })

  // Replaces the extension's `GET /api/price/{ticker}/{timestamps}`, which is what puts a fiat
  // value on a transaction in someone's history.
  app.get('/v1/price/ada/history', async (request) => {
    const parsed = historyQuery.safeParse(request.query)
    if (!parsed.success) {
      throw new BadRequestError(`query must be range=${PRICE_RANGES.join('|')} and a currency code`)
    }
    return requireProvider().getAdaHistory(parsed.data.range, parsed.data.currency)
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
    return requireProvider().getTokenActivity(parsed.data.subjects, parsed.data.window)
  })

  // Replaces the dullahan `POST /tokens/history/price`, which draws the token chart.
  app.post('/v1/price/tokens/history', async (request) => {
    const parsed = tokenHistoryBody.safeParse(request.body)
    if (!parsed.success) {
      throw new BadRequestError(
        `body must be { "subject": "...", "range": "${PRICE_RANGES.join('|')}" }`,
      )
    }
    return requireProvider().getTokenHistory(parsed.data.subject, parsed.data.range)
  })
}
