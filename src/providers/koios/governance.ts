import { z } from 'zod'
import { ProviderError } from '../../domain/errors.js'
import { drepCredentialHex } from '../../domain/drep.js'
import type { DrepInfo, DrepListParams } from '../../domain/types/governance.js'
import type { GovernanceCapability } from '../capabilities/governance.js'
import type { KoiosClient } from './client.js'
import { chunked, numeric } from './schema.js'

// A DRep id is about the same size as a pool id, and /drep_info has the same body cap.
const DREP_INFO_CHUNK = 50
// Koios caps a response at 1000 rows; ~1.7k DReps on mainnet today.
const DREP_LIST_PAGE_SIZE = 1000
const DREP_LIST_MAX_PAGES = 20

const drepListRow = z.object({
  drep_id: z.string(),
  registered: z.boolean(),
})

const drepInfoRow = z.object({
  drep_id: z.string(),
  // The 28-byte credential, so 56 hex chars. This is the key every lookup below joins on, so
  // a malformed value here does not merely look wrong: the row fails to match the id the
  // caller asked about, and the DRep silently disappears from the response. Constrain it and
  // bad upstream data takes the malformed path instead.
  hex: z.string().regex(/^[0-9a-fA-F]{56}$/),
  has_script: z.boolean(),
  // The three values Koios's own API spec declares for this field. `not_registered` does not
  // appear in any drep_list row (every DRep listed there is registered or deregistered), but
  // it is what a query for a DRep id that never registered comes back with, so it belongs
  // here. Anything outside the spec is unexpected upstream data and takes the malformed
  // path, the same as pool_status. Constraining it is also what keeps the public `status`
  // field a normalized DrepStatus rather than a pass-through of Koios's vocabulary, so a
  // different provider can satisfy the same contract.
  drep_status: z.enum(['registered', 'deregistered', 'not_registered']),
  // Strict, per the spec, which declares this a plain boolean. Mainnet has been seen
  // answering with it null from the same instances that intermittently fail a filtered
  // drep_list (reported as koios-artifacts#411). That is an upstream defect, and it fails
  // loudly here rather than being defaulted: a DRep's standing is not something to guess at,
  // and quietly reading a broken response as "not active" would hide the problem.
  active: z.boolean(),
  deposit: numeric.nullish(),
  amount: numeric.nullish(),
  expires_epoch_no: z.number().int().nonnegative().nullish(),
  meta_url: z.string().nullish(),
  meta_hash: z.string().nullish(),
})

const drepMetadataRow = z.object({
  drep_id: z.string(),
  // Off-chain (CIP-119) JSON, resolved by Koios. Attacker-influenced, so walked defensively;
  // null when Koios hasn't fetched it or it failed to parse.
  meta_json: z.unknown().nullish(),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function mapDrepInfo(row: z.infer<typeof drepInfoRow>): DrepInfo {
  return {
    drepId: row.drep_id,
    hex: row.hex,
    hasScript: row.has_script,
    status: row.drep_status,
    active: row.active,
    deposit: String(row.deposit ?? 0),
    votingPower: String(row.amount ?? 0),
    expiresEpoch: row.expires_epoch_no ?? undefined,
    metadataUrl: row.meta_url ?? undefined,
    metadataHash: row.meta_hash ?? undefined,
  }
}

// CIP-119 puts the display name at body.givenName; some DReps use a flatter top-level
// { name, ... }. Try both. The image, when present, is a URL under body.image.contentUrl.
function drepMetaFields(metaJson: unknown): { name?: string; image?: string } {
  if (!isRecord(metaJson)) return {}
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined
  const body = isRecord(metaJson.body) ? metaJson.body : undefined
  const name = str(body?.givenName) ?? str(metaJson.name)
  const image = body && isRecord(body.image) ? str(body.image.contentUrl) : undefined
  return { ...(name ? { name } : {}), ...(image ? { image } : {}) }
}

export function createGovernanceMethods(koios: KoiosClient): GovernanceCapability {
  // Read DRep ids in upstream order, keeping the registered ones, until `needed` of them are
  // in hand or the list runs out.
  //
  // The `registered` filter is applied here rather than upstream: see getDrepList. Stopping
  // at `needed` is what keeps that local filtering from costing a full scan of every DRep on
  // every request. A caller asking for the first page of 50 reads one upstream page, not
  // twenty, which is a straight cut in latency and in rate-limit exposure.
  async function registeredDreps(needed: number): Promise<string[]> {
    const ids: string[] = []
    for (let page = 0; page < DREP_LIST_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        order: 'drep_id.asc',
        select: 'drep_id,registered',
        limit: String(DREP_LIST_PAGE_SIZE),
        offset: String(page * DREP_LIST_PAGE_SIZE),
      })
      const data = await koios.request(`/drep_list?${query.toString()}`)
      const rows = koios.parseWith(z.array(drepListRow), data, '/drep_list')
      for (const row of rows) {
        if (row.registered) ids.push(row.drep_id)
      }

      // A short page is the end of the list upstream. An offset past the end then yields an
      // empty page, which is the correct answer, not an error.
      if (rows.length < DREP_LIST_PAGE_SIZE) return ids
      if (ids.length >= needed) return ids
    }

    // The page cap ran out while upstream was still handing back full pages, so there is
    // more DRep list than was scanned. Say so rather than serving a truncated list as if it
    // were the whole one: silently short pages are how a DRep disappears from a wallet's
    // list and nobody finds out.
    throw new ProviderError(
      `koios /drep_list has more than ${DREP_LIST_MAX_PAGES * DREP_LIST_PAGE_SIZE} rows, ` +
        `beyond this provider's scan bound`,
    )
  }

  // Off-chain DRep names and images, best-effort.
  //
  // Best-effort means exactly that: a DRep's name is a nicety, its on-chain standing is not.
  // Every failure mode here returns an empty map rather than throwing, so a bad
  // /drep_metadata response can never take down a DRep lookup that otherwise succeeded.
  //
  // That includes a 200 whose body does not match the schema, which is why the parse is
  // guarded too. An unguarded parse would make the "best effort" claim false for the one
  // case most likely to happen: Koios changing the shape of a field we do not even need.
  async function drepMetadataByHex(
    drepIds: string[],
  ): Promise<Map<string, { name?: string; image?: string }>> {
    const byHex = new Map<string, { name?: string; image?: string }>()
    for (const chunk of chunked(drepIds, DREP_INFO_CHUNK)) {
      try {
        const data = await koios.postJson('/drep_metadata', { _drep_ids: chunk })
        const rows = koios.parseWith(z.array(drepMetadataRow), data, '/drep_metadata')
        for (const row of rows) {
          const hex = drepCredentialHex(row.drep_id)
          if (hex !== undefined) byHex.set(hex, drepMetaFields(row.meta_json))
        }
      } catch {
        // Names for this chunk are simply unavailable. The DReps still resolve.
        continue
      }
    }
    return byHex
  }

  // Hydrate a set of drep ids with full drep_info, plus best-effort off-chain name/image.
  // Preserves the input order; unknown ids are absent, so the result is never longer than
  // the input.
  //
  // Chunked for the same reason as pool_info: Koios rejects an oversized body with a 413.
  //
  // Responses are indexed by credential hex, not by the bech32 id, because the two are not
  // necessarily the same string the caller sent. A DRep has both a CIP-129 id and a
  // deprecated CIP-105 one, Koios accepts either on the way in but always answers with the
  // CIP-129 form, so a caller asking by CIP-105 would never match its own row and the DRep
  // would silently vanish from the result. The hex credential is the same either way.
  async function drepInfoByIds(drepIds: string[]): Promise<DrepInfo[]> {
    if (drepIds.length === 0) return []

    const [infoByHex, metaByHex] = await Promise.all([
      (async () => {
        const byHex = new Map<string, z.infer<typeof drepInfoRow>>()
        for (const chunk of chunked(drepIds, DREP_INFO_CHUNK)) {
          const data = await koios.postJson('/drep_info', { _drep_ids: chunk })
          const rows = koios.parseWith(z.array(drepInfoRow), data, '/drep_info')
          for (const row of rows) byHex.set(row.hex.toLowerCase(), row)
        }
        return byHex
      })(),
      drepMetadataByHex(drepIds),
    ])

    return drepIds.flatMap((id) => {
      const hex = drepCredentialHex(id)
      if (hex === undefined) return []
      const row = infoByHex.get(hex)
      return row ? [{ ...mapDrepInfo(row), ...metaByHex.get(hex) }] : []
    })
  }

  return {
    getDrepInfo(drepIds: string[]): Promise<DrepInfo[]> {
      return drepInfoByIds(drepIds)
    },

    async getDrepList({ limit, offset }: DrepListParams): Promise<DrepInfo[]> {
      // Neutral, unranked page of registered DReps, ordered by id so paging is stable. No
      // ranking, promotional or otherwise: the order is the id, and nothing else.
      //
      // The registered-only filter is applied here rather than upstream. Asking Koios for
      // `registered=eq.true` fails intermittently on mainnet with "column record.registered
      // does not exist" (about half of all requests, so it looks like the query only lands
      // on some of the instances behind the endpoint). The field itself is reliably present
      // in the rows, so the whole list is read and filtered here. That is also what makes
      // paging honest: filtering after an upstream limit/offset would hand back short pages.
      const registered = await registeredDreps(offset + limit)
      const page = registered.slice(offset, offset + limit)
      return drepInfoByIds(page)
    },
  }
}
