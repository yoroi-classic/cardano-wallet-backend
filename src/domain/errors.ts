/**
 * Error taxonomy for the backend. Everything a provider or route throws should be
 * one of these so the HTTP layer can map it to a stable status code and body.
 */

export type ErrorCode =
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_MALFORMED'
  | 'BAD_REQUEST'
  | 'NOT_IMPLEMENTED'
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
 */
export class NotImplementedError extends AppError {
  constructor(message: string) {
    super('NOT_IMPLEMENTED', 501, message)
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
