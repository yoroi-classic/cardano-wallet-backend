import type { Tip } from './chain.js'

export interface StatusInfo {
  /** Service version, so a client can tell which build it is talking to. */
  version: string
  /** The Cardano network this instance serves. A wallet pointed at the wrong one must find out. */
  network: string
  /** Which upstream chain-data provider is behind it. */
  provider: string
}

/** Unix time in milliseconds, constrained to the exact integer range JSON clients can preserve. */
export type ServerTime = number

export function asServerTime(value: number): ServerTime {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('server time must be a non-negative safe integer')
  }
  return value
}

interface StatusResponseBase extends StatusInfo {
  /** Unix time in milliseconds when the server constructed this response. */
  serverTime: ServerTime
}

export interface AvailableStatusResponse extends StatusResponseBase {
  chain: 'ok' | 'stale'
  behindSeconds: number
  tip: Tip
}

export interface DownStatusResponse extends StatusResponseBase {
  chain: 'down'
  tip: null
}

export type StatusResponse = AvailableStatusResponse | DownStatusResponse
