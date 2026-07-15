import type { Cache } from '../cache/index.js'
import type { ChainProvider } from './provider.js'

/**
 * How long a cached tip is served for.
 *
 * Cardano produces a block every ~20s on average, so a 10s window means a caller is at most one
 * block behind something they would have had to poll for anyway. What this buys is that the tip,
 * which every client reads and which is identical for all of them, stops being an upstream call
 * per request.
 */
export const TIP_TTL_MS = 10_000

/**
 * The one key the tip is cached under, exported so nothing else invents a second one.
 *
 * The pool module needs the current epoch to key its ranking on, and it must get it from the
 * *same* cache entry this decorator uses. Two keys for one tip would mean two upstream reads and,
 * worse, two answers: at an epoch boundary the decorator and the pool ranking could briefly
 * disagree about which epoch it is, and the ranking would be keyed on an epoch nobody else
 * believed in.
 */
export const TIP_CACHE_KEY = 'chain:tip'

/**
 * Protocol parameters are keyed on the epoch, so this TTL is a memory bound rather than a
 * freshness policy: it only has to outlive an epoch (5 days) so the entry survives as long as
 * its key is current.
 */
export const PROTOCOL_PARAMS_TTL_MS = 6 * 24 * 60 * 60 * 1000

/**
 * Wrap a provider so the chain-wide reads are cached.
 *
 * ## Why a decorator, and not caching inside the Koios modules
 *
 * The cached value is the *normalized domain value*, not the raw upstream body. That means the
 * cache format does not depend on which provider produced it, so the Blockfrost driver gets
 * caching for free when it lands, and swapping providers does not invalidate anything. It also
 * keeps the Koios modules pure functions of their client, which is what makes them so cheap to
 * test.
 *
 * The more important reason is that it makes the *policy* readable. Everything this service
 * caches is in this one file, in one list, and anything absent from that list is not cached.
 * That is a property you can check by reading forty lines, rather than by auditing seven modules
 * and hoping.
 *
 * ## What is deliberately absent
 *
 * **Every account-scoped read.** `getAccountState`, `getAccountUtxos`, `getTxHistory`,
 * `getTxStatus`. These are per-user and must be fresh: serving a stale balance or a stale UTxO
 * set to a wallet that is about to build a transaction produces a failed submission or a
 * double-spend, and there is no TTL short enough to make that a good trade. They are not
 * overridden here, so they pass straight through to the provider. Do not add them without an
 * explicit, argued decision.
 *
 * `submitTx` likewise, for the obvious reason.
 *
 * ## What is not here *yet*
 *
 * The pool ranking (#49) and the DRep list (#52) are the two heaviest reads we have, and neither
 * can be cached from out here. The expensive thing in each is not the public result but an
 * internal intermediate: the full registered-set scan that the ordering is computed from. Caching
 * `getPoolList(limit, offset)` by its arguments would cache each *page* separately, and a cold
 * page would still trigger the whole scan, so N pages would still mean N scans. That is the
 * problem, not a smaller version of it. Those two need the cache pushed into their modules, where
 * the scan is, and they get their own PRs.
 */
export function withCache(provider: ChainProvider, cache: Cache): ChainProvider {
  const getTip: ChainProvider['getTip'] = () =>
    cache.read(TIP_CACHE_KEY, TIP_TTL_MS, () => provider.getTip())

  return {
    ...provider,

    getTip,

    // Keyed on the epoch, not on a duration, because that is what protocol parameters actually
    // are: they change at an epoch boundary and are fixed in between. A TTL would be wrong in
    // both directions at once, too short to be worth having for five days of identical answers
    // and too long to be correct at the one moment the values move.
    //
    // Putting the epoch in the key means the entry expires exactly when the thing it describes
    // does. The epoch comes from the cached tip, so this costs an upstream call once per epoch
    // rather than once per request, and nothing on the hot path.
    getProtocolParams: async () => {
      const { epoch } = await getTip()
      return cache.read(`chain:protocol-params:${epoch}`, PROTOCOL_PARAMS_TTL_MS, () =>
        provider.getProtocolParams(),
      )
    },
  }
}
