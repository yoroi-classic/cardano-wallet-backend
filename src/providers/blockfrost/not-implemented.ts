import { NotImplementedError } from '../../domain/errors.js'

/**
 * Marks a capability this driver's first pass does not cover yet.
 *
 * A distinct, named throw rather than a generic error or a silently empty/default result, so a
 * caller (and a log) can tell "not built yet" apart from "built, and the real answer is empty" —
 * see the NotImplementedError docstring in domain/errors.ts for why that distinction matters. A
 * client can be written against these methods today and will start working the day a follow-up
 * PR fills them in, with no client change.
 *
 * `what` should name the capability method, e.g. `getTokenMetadata`, so the message is useful
 * without a stack trace.
 *
 * `reason` overrides the default "not built yet" message for the case where a capability is not
 * merely unbuilt but cannot be served on Blockfrost at all (no upstream endpoint answers it), so the
 * 501 carries the precise reason rather than implying a follow-up will fill it in.
 */
export function notImplemented(what: string, reason?: string): never {
  throw new NotImplementedError(
    reason ?? `blockfrost driver does not implement ${what} yet; see issue #4 for what is left`,
  )
}
