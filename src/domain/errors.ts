/**
 * Error taxonomy for the backend. Everything a provider or route throws should be
 * one of these so the HTTP layer can map it to a stable status code and body.
 */

export type ErrorCode =
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_MALFORMED'
  | 'NOT_IMPLEMENTED'
  | 'BAD_REQUEST'
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

/** A capability the selected provider doesn't offer yet. */
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
