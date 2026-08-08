import { z } from 'zod'
import { ProviderError } from '../../domain/errors.js'
import type { BlockfrostClient } from './client.js'

// Blockfrost's own documented maximum page size for its list endpoints.
const DEFAULT_PAGE_SIZE = 100
// 500 pages of 100 is 50,000 rows, far above any list this driver walks (roughly 3k pools and 2k
// DReps on mainnet today). It only exists so a list that never stops shrinking cannot spin
// forever; a genuine overrun is reported rather than silently truncated.
const DEFAULT_MAX_PAGES = 500

/**
 * Walk a Blockfrost list endpoint's `count`/`page` pagination, accumulating rows until either the
 * list ends (a short page), enough rows are in hand (`needed`), or the scan bound is hit.
 *
 * `needed` is what keeps a bounded read bounded: an endpoint serving a small page (a DRep or
 * proposal list slice) passes `offset + limit` and stops as soon as that many rows are read, rather
 * than scanning the whole list every time. An endpoint that genuinely needs the whole set (the pool
 * ranking, which sorts by a value it cannot push upstream) passes `Number.POSITIVE_INFINITY` and
 * reads to the end.
 *
 * `basePath` may already carry a query string (an `order=desc`, say); the `count` and `page` params
 * are appended with the right separator.
 *
 * On hitting the page cap with a still-full last page, one extra page is probed to tell "ended
 * exactly on the boundary" apart from "genuinely longer than we scanned", the same technique the
 * Koios driver and this driver's own account walk use. A real overrun throws rather than serving a
 * quietly truncated list.
 */
export async function collectPages<T>(
  client: BlockfrostClient,
  schema: z.ZodType<T>,
  basePath: string,
  needed: number,
  opts: { pageSize?: number; maxPages?: number; label?: string } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  const sep = basePath.includes('?') ? '&' : '?'
  const pageAt = (page: number): string => `${basePath}${sep}count=${pageSize}&page=${page}`

  const rows: T[] = []
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await client.get(z.array(schema), pageAt(page))
    rows.push(...batch)

    // A short page is the end of the list upstream.
    if (batch.length < pageSize) return rows
    // Enough rows to serve the caller's window; no reason to read further.
    if (rows.length >= needed) return rows
  }

  // The cap ran out on a full page. Ask for one more to tell a list that ended exactly on the
  // boundary apart from one that really is longer than the scan bound.
  const probe = await client.get(z.array(schema), pageAt(maxPages + 1))
  if (probe.length === 0) return rows

  throw new ProviderError(
    `blockfrost ${opts.label ?? basePath} exceeds this provider's ` +
      `${maxPages * pageSize}-row scan bound`,
  )
}
