/**
 * What this service is allowed to write down about who asked it what.
 *
 * A wallet backend sees, on every call, the one thing a wallet most wants kept to itself: which
 * addresses and which stake key belong to one person. Our positioning is privacy-first, so what
 * we log is part of the product, not an ops detail.
 *
 * Fastify's default request log is a privacy failure for exactly this service. It writes the
 * request URL and the client's IP on the same line, and our account routes carry the stake key
 * *in the URL*:
 *
 *   {"req":{"url":"/v1/account/stake1uyehk.../utxos","remoteAddress":"203.0.113.47"}}
 *
 * That is a durable, precise link between a wallet identity and a network identity, written to
 * disk, on every balance refresh. Anyone who later reads those logs (us, a host, an attacker, a
 * subpoena) can reconstruct who holds what. Nothing else we do about privacy matters if we are
 * writing that line.
 *
 * So: the identifiers come out of the path, and the IP does not go in at all.
 *
 * Note the honest limit of this. We still *see* the stake key in order to answer the request, and
 * we still see the IP in order to receive it. Not logging them means the linkage is not retained,
 * which is a real and worthwhile property, but it is not the same as never having had it. A user
 * who wants that guarantee needs to run their own node, and we should say so rather than imply
 * this is more than it is.
 */

const REDACTED = '[redacted]'
const MAX_DECODE_PASSES = 3

/** A bech32 stake address, mainnet or testnet. Appears as a path segment on the account routes. */
const STAKE_ADDRESS = /^stake(_test)?1[0-9a-z]+$/i

/** A 32-byte hash as hex: a transaction id, on /v1/tx/{hash}/status. */
const TX_HASH = /^[0-9a-fA-F]{64}$/

function scrubSegment(segment: string): string {
  let decoded = segment
  for (let passes = 0; passes < MAX_DECODE_PASSES; passes += 1) {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      // Invalid escapes must not make the request serializer throw. Redact the whole segment:
      // retaining malformed input would fail open and could still persist most of an identifier.
      return REDACTED
    }
    if (STAKE_ADDRESS.test(decoded) || TX_HASH.test(decoded)) {
      return REDACTED
    }
    if (!/%[0-9a-fA-F]{2}/.test(decoded)) {
      return segment
    }
  }

  // Do not spend unbounded work decoding attacker-controlled path segments. A deeply nested
  // encoding is not a valid identifier we need to preserve, so redact it conservatively.
  return REDACTED
}

/**
 * The request path with any wallet identifier removed, so the log still says which endpoint was
 * called and how often, but not by whom.
 *
 * The query string is kept: `?limit=50`, `?ticker=ADA`, `?after=12345` say nothing about who is
 * asking. Identifiers only ever arrive as path segments or in a POST body, and Fastify does not
 * log bodies.
 */
export function scrubPath(url: string): string {
  const [path = '', query] = url.split('?')
  const scrubbed = path.split('/').map(scrubSegment).join('/')
  return query === undefined ? scrubbed : `${scrubbed}?${query}`
}

/**
 * The same identifiers, found anywhere in free text rather than as a whole path segment.
 *
 * Kept separate from the anchored patterns above on purpose. Those answer "is this segment an
 * identifier"; these answer "does this sentence contain one", which is a more permissive question,
 * and reusing one for both would quietly widen path redaction.
 *
 * Payment addresses are included here where `scrubSegment` does not need them. They never arrive as
 * a path segment on our routes, but they do appear in the upstream paths we build, for instance
 * Blockfrost's `/addresses/{address}/utxos`.
 */
const WALLET_BECH32 = /\b(?:stake|addr)(?:_test)?1[0-9a-z]{20,}/gi
const HASH_HEX = /\b[0-9a-f]{64}\b/gi

/**
 * A message with any wallet identifier removed, for the two places an upstream failure is repeated
 * in public: the response body the error handler builds from it, and the retry warn line.
 *
 * The paths we send upstream are not covered by the assumption `scrubPath` documents. We build
 * them, and some have to carry an identifier in the query string because the upstream offers no
 * other form: Koios documents `/account_txs` as GET with `_stake_address`, so a 502 on an account
 * history read names the caller's stake key in its message. Redacting at this boundary means the
 * next upstream path written the obvious way cannot reintroduce the leak.
 *
 * The endpoint survives, so the message still says what failed:
 * `koios returned 502 for /account_txs?_stake_address=[redacted]`.
 */
export function scrubMessage(message: string): string {
  return message.replace(WALLET_BECH32, REDACTED).replace(HASH_HEX, REDACTED)
}

/**
 * A retry event safe to log. Both of its path-bearing fields go through `scrubMessage`, because
 * the retry warn line is written at the shipped default `LOG_LEVEL=info`, which makes it the one
 * place a transient upstream failure would otherwise persist an identifier next to a timestamp.
 *
 * Structurally typed rather than importing a provider's `RetryEvent`, so the log boundary does not
 * depend on which provider raised the event, and every other field is passed through untouched.
 */
export function scrubRetryEvent<Event extends { path: string; message: string }>(
  event: Event,
): Event {
  return { ...event, path: scrubMessage(event.path), message: scrubMessage(event.message) }
}

interface LoggableRequest {
  method: string
  url: string
}

/**
 * The request serializer the app logs through. Deliberately a short allowlist rather than a
 * denylist of things to strip: a denylist silently starts leaking the day Fastify adds a field,
 * and this is not a thing to be wrong about by default.
 *
 * `remoteAddress`, `remotePort`, headers, and the request body are all simply absent.
 */
export function serializeRequest(request: LoggableRequest): { method: string; url: string } {
  return { method: request.method, url: scrubPath(request.url) }
}
