/**
 * Error taxonomy for the backend. Everything a provider or route throws should be
 * one of these so the HTTP layer can map it to a stable status code and body.
 */

export type ErrorCode =
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_MALFORMED'
  | 'BAD_REQUEST'
  // Two different kinds of "not right now", and a client acts on them differently.
  // NOT_IMPLEMENTED (501): we have not built it yet, and no configuration will change that.
  // FEATURE_UNAVAILABLE (503): it is built, but this deployment lacks an optional credential.
  | 'NOT_IMPLEMENTED'
  | 'FEATURE_UNAVAILABLE'
  | 'CONFIG_ERROR'
  | 'INTERNAL'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly statusCode: number
  readonly details?: unknown

  constructor(code: ErrorCode, statusCode: number, message: string, details?: unknown) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

/** The upstream provider answered, but with an error status or an error we can't recover from. */
export class ProviderError extends AppError {
  readonly upstreamStatus?: number
  constructor(message: string, opts?: { upstreamStatus?: number; cause?: unknown }) {
    super('UPSTREAM_ERROR', 502, message, opts?.cause)
    this.upstreamStatus = opts?.upstreamStatus
    if (opts?.cause !== undefined) this.cause = opts.cause
  }
}

/** The upstream provider didn't answer in time. */
export class ProviderTimeoutError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('UPSTREAM_TIMEOUT', 504, message, cause)
    if (cause !== undefined) this.cause = cause
  }
}

/** The upstream answered but the payload wasn't the shape we expected. */
export class MalformedUpstreamError extends AppError {
  constructor(message: string, details?: unknown) {
    super('UPSTREAM_MALFORMED', 502, message, details)
  }
}

/** The caller sent something invalid. */
export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super('BAD_REQUEST', 400, message, details)
  }
}

/**
 * The endpoint exists in the contract but is not built yet.
 *
 * A distinct code, and not a 404, because the two mean opposite things to a client: a 404 says
 * "you asked for something that does not exist, fix your call", and this says "you asked
 * correctly, we owe you an answer". An adapter can be written against a route that answers this,
 * and will start working the day the route does, with no client change.
 *
 * Not to be confused with FeatureUnavailableError below. This one no amount of configuration will
 * fix; that one is fixed by supplying a credential.
 */
export class NotImplementedError extends AppError {
  constructor(message: string) {
    super('NOT_IMPLEMENTED', 501, message)
  }
}

/**
 * The endpoint is real, but this deployment is not configured to serve it.
 *
 * Distinct from a 404, which would tell a client the route does not exist and to stop calling it,
 * and from a 500, which would tell it we are broken. Neither is true: the operator has simply not
 * supplied a credential for an optional upstream, and a client should degrade (show a placeholder
 * image) rather than retry or give up on the endpoint forever.
 */
export class FeatureUnavailableError extends AppError {
  constructor(message: string) {
    super('FEATURE_UNAVAILABLE', 503, message)
  }
}

/** Bad configuration, surfaced at startup. */
export class ConfigError extends AppError {
  constructor(message: string, details?: unknown) {
    super('CONFIG_ERROR', 500, message, details)
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError
}
