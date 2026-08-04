import { z } from 'zod'
import { noCache, type Cache } from '../../cache/index.js'
import { ProviderError } from '../../domain/errors.js'
import { drepCredentialHex } from '../../domain/drep.js'
import {
  PROPOSAL_TYPES,
  type DrepInfo,
  type DrepListParams,
  type Proposal,
  type ProposalListParams,
  type ProposalStatus,
  type VoteCountTally,
  type VoteTally,
} from '../../domain/types/governance.js'
import type { GovernanceCapability } from '../capabilities/governance.js'
import type { KoiosClient } from './client.js'
import { numeric, packBySize } from './schema.js'

// Koios caps a response at 1000 rows; ~1.7k DReps on mainnet today.
const DREP_LIST_PAGE_SIZE = 1000
const DREP_LIST_MAX_PAGES = 20

/**
 * How long the DRep *membership* list is cached.
 *
 * Membership, not the numbers. DReps register and deregister continuously, but not fast enough
 * that a couple of minutes of staleness in *who is on the list* misleads anyone. What is emphati-
 * cally not cached for two minutes is a DRep's `votingPower` or `active` flag: those are the
 * figures someone reads while deciding who to delegate their vote to, and they are hydrated fresh
 * on every request. See getDrepList.
 *
 * The read this replaces is the reason it matters: the registered filter cannot be pushed upstream
 * (Koios fails `registered=eq.true` about half the time on mainnet), so every request scans the
 * whole list and filters here. Caching the membership turns that from once-per-request into
 * once-per-two-minutes.
 */
const DREP_MEMBERSHIP_TTL_MS = 2 * 60_000

/** Held a little past expiry if a refresh fails: a slightly stale *membership* list beats a 502. */
const DREP_MEMBERSHIP_STALE_MS = 10 * 60_000

/**
 * Off-chain names and images change only when a DRep updates their metadata, which is rare, so
 * they get a long TTL. This is a separate cache from the membership because it answers a separate
 * question, and resolving it is a separate upstream call we would rather not repeat.
 */
const DREP_METADATA_TTL_MS = 60 * 60_000

const drepListRow = z.object({
  drep_id: z.string(),
  registered: z.boolean(),
})

const drepInfoRow = z
  .object({
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
    //
    // Failing loudly is not the same as failing the request. The client retries a read that
    // comes back off-spec, so a null from one bad instance is very likely answered correctly by
    // the next attempt. What it must never do is coerce the null into a `false`.
    active: z.boolean(),
    deposit: numeric.nullish(),
    amount: numeric.nullish(),
    expires_epoch_no: z.number().int().nonnegative().nullish(),
    meta_url: z.string().nullish(),
    meta_hash: z.string().nullish(),
  })
  // drep_id and hex are two encodings of one credential, so they have to agree. If they do
  // not, the row is internally inconsistent and there is no safe way to pick a winner: the
  // lookup below joins on hex, so trusting it would emit the *other* DRep's id to the caller,
  // and trusting drep_id would file the row under a credential it does not have.
  .refine((row) => drepCredentialHex(row.drep_id) === row.hex.toLowerCase(), {
    message: 'drep_id and hex describe different credentials',
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

// Koios reports a proposal's fate as four separate nullable epoch fields. Constrained to the
// documented action types, so an unexpected one is malformed upstream data rather than a new kind
// of governance action quietly appearing in our contract.
const proposalRow = z.object({
  proposal_id: z.string().regex(/^gov_action1[0-9a-z]+$/),
  proposal_tx_hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  proposal_index: z.number().int().nonnegative(),
  proposal_type: z.enum(PROPOSAL_TYPES),
  deposit: numeric,
  return_address: z.string(),
  proposed_epoch: z.number().int().nonnegative(),
  expiration: z.number().int().nonnegative().nullish(),
  ratified_epoch: z.number().int().nonnegative().nullish(),
  enacted_epoch: z.number().int().nonnegative().nullish(),
  dropped_epoch: z.number().int().nonnegative().nullish(),
  expired_epoch: z.number().int().nonnegative().nullish(),
  meta_url: z.string().nullish(),
  meta_hash: z.string().nullish(),
  // CIP-108 off-chain JSON, resolved by Koios. Attacker-influenced, so walked defensively.
  meta_json: z.unknown().nullish(),
  meta_is_valid: z.boolean().nullish(),
})

// Vote power is lovelace and can exceed 2^53, so it stays a string all the way through. The vote
// *counts* are counts, and are numbers.
const voteCount = z.number().int().nonnegative()

const votingSummaryRow = z.object({
  drep_yes_votes_cast: voteCount.nullish(),
  drep_no_votes_cast: voteCount.nullish(),
  drep_abstain_votes_cast: voteCount.nullish(),
  drep_yes_vote_power: numeric.nullish(),
  drep_no_vote_power: numeric.nullish(),
  drep_active_abstain_vote_power: numeric.nullish(),
  drep_always_abstain_vote_power: numeric.nullish(),
  pool_yes_votes_cast: voteCount.nullish(),
  pool_no_votes_cast: voteCount.nullish(),
  pool_abstain_votes_cast: voteCount.nullish(),
  pool_yes_vote_power: numeric.nullish(),
  pool_no_vote_power: numeric.nullish(),
  pool_active_abstain_vote_power: numeric.nullish(),
  pool_passive_always_abstain_vote_power: numeric.nullish(),
  committee_yes_votes_cast: voteCount.nullish(),
  committee_no_votes_cast: voteCount.nullish(),
  committee_abstain_votes_cast: voteCount.nullish(),
})

/**
 * Where a proposal has got to.
 *
 * Derived here so that every client does not reimplement the same precedence rules, subtly
 * differently, from four nullable epoch fields. `enacted` outranks `ratified` because a proposal
 * is ratified first and enacted afterwards, so a proposal that reached both is *enacted*: reading
 * it the other way would report the older state and tell a user a decision had not yet taken
 * effect when it had.
 */
function proposalStatus(row: z.infer<typeof proposalRow>): {
  status: ProposalStatus
  decidedEpoch?: number
} {
  if (row.enacted_epoch != null) return { status: 'enacted', decidedEpoch: row.enacted_epoch }
  if (row.ratified_epoch != null) return { status: 'ratified', decidedEpoch: row.ratified_epoch }
  if (row.dropped_epoch != null) return { status: 'dropped', decidedEpoch: row.dropped_epoch }
  if (row.expired_epoch != null) return { status: 'expired', decidedEpoch: row.expired_epoch }
  return { status: 'open' }
}

/** CIP-108 puts the human-readable parts under `body`. */
function proposalMeta(metaJson: unknown): { title?: string; abstract?: string } {
  if (!isRecord(metaJson)) return {}
  const body = isRecord(metaJson.body) ? metaJson.body : metaJson
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined
  const title = str(body.title)
  const summary = str(body.abstract)
  return { ...(title ? { title } : {}), ...(summary ? { abstract: summary } : {}) }
}

const voteCountTally = (
  yes: number | null | undefined,
  no: number | null | undefined,
  abstain: number | null | undefined,
): VoteCountTally => ({
  yes: yes ?? 0,
  no: no ?? 0,
  abstain: abstain ?? 0,
})

const stakeWeightedTally = (
  yes: number | null | undefined,
  no: number | null | undefined,
  abstain: number | null | undefined,
  yesPower: unknown,
  noPower: unknown,
  abstainPower: unknown,
): VoteTally => ({
  ...voteCountTally(yes, no, abstain),
  yesPower: String(yesPower ?? 0),
  noPower: String(noPower ?? 0),
  abstainPower: String(abstainPower ?? 0),
})

const addNumeric = (...values: unknown[]): string =>
  values.reduce((sum, value) => sum + BigInt(value ?? 0), 0n).toString()

export interface GovernanceMethodDeps {
  /** Cache for the DRep membership list and the off-chain names. Defaults to none. */
  cache?: Cache
}

export function createGovernanceMethods(
  koios: KoiosClient,
  deps: GovernanceMethodDeps = {},
): GovernanceCapability {
  const cache = deps.cache ?? noCache
  // Whether we have a *real* cache. It changes the strategy, not just the speed: with a cache we
  // read the *whole* membership once and slice every page from it; without one, we keep the
  // early-exit that stops the walk as soon as the requested page is in hand, because reading the
  // whole list on every uncached request would be strictly worse than the bounded read it
  // replaced. Compared against the noCache singleton rather than `undefined`, because the provider
  // always passes a cache down and it is noCache that means "not caching".
  const caching = cache !== noCache

  /** A namespaced view of the shared cache, so a DRep hex cannot collide with any other key. */
  const metadataCache = {
    peek: (hex: string): { name?: string; image?: string } | undefined =>
      cache.peek(`gov:drep-meta:${hex}`),
    set: (hex: string, fields: { name?: string; image?: string }): void =>
      cache.set(`gov:drep-meta:${hex}`, fields, DREP_METADATA_TTL_MS),
  }

  // Read DRep ids in upstream order, keeping the registered ones, until `needed` of them are
  // in hand or the list runs out.
  //
  // The `registered` filter is applied here rather than upstream: see getDrepList. Stopping
  // at `needed` is what keeps that local filtering from costing a full scan of every DRep on
  // every request. A caller asking for the first page of 50 reads one upstream page, not
  // twenty, which is a straight cut in latency and in rate-limit exposure.
  async function registeredDreps(needed: number): Promise<string[]> {
    const ids: string[] = []
    let after: string | undefined

    function pageQuery(limit: number): URLSearchParams {
      const query = new URLSearchParams({
        order: 'drep_id.asc',
        select: 'drep_id,registered',
        limit: String(limit),
      })
      // Keyset, not offset. DReps register and retire while this walk is in flight, and an
      // offset counts rows from the start every time: one DRep leaving mid-walk slides the
      // whole tail up by one and the next page skips a DRep that was never read. Anchoring
      // on the last id seen instead means the cursor survives anything happening behind it.
      if (after !== undefined) query.set('drep_id', `gt.${after}`)
      return query
    }

    for (let page = 0; page < DREP_LIST_MAX_PAGES; page += 1) {
      const rows = await koios.get(
        z.array(drepListRow),
        `/drep_list?${pageQuery(DREP_LIST_PAGE_SIZE).toString()}`,
      )
      for (const row of rows) {
        if (row.registered) ids.push(row.drep_id)
      }

      // A short page is the end of the list upstream. An offset past the end then yields an
      // empty page, which is the correct answer, not an error.
      if (rows.length < DREP_LIST_PAGE_SIZE) return ids
      after = rows[rows.length - 1]?.drep_id
      if (after === undefined) return ids
      if (ids.length >= needed) return ids
    }

    // The cap ran out on a full page, which does not by itself mean anything was missed: a
    // list of exactly DREP_LIST_MAX_PAGES * DREP_LIST_PAGE_SIZE rows ends on a full page and
    // has been read in full. Ask for one more row to tell the two apart, rather than failing
    // a request that actually succeeded.
    const probe = await koios.get(z.array(drepListRow), `/drep_list?${pageQuery(1).toString()}`)
    if (probe.length === 0) return ids

    // There really is more list than was scanned. Say so rather than serving a truncated list
    // as if it were the whole one: silently short pages are how a DRep disappears from a
    // wallet's list and nobody finds out.
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
  // Packed by hand rather than through batchAll, and the difference is the point: this is the one
  // batch whose chunks are allowed to fail independently. batchAll fails the whole batch if any
  // chunk does, which is right everywhere else and wrong here, because it would turn one bad
  // /drep_metadata response into every DRep losing its name rather than one chunk of them.
  async function drepMetadataByHex(
    drepIds: string[],
  ): Promise<Map<string, { name?: string; image?: string }>> {
    const byHex = new Map<string, { name?: string; image?: string }>()

    // Serve from cache what we can, and ask upstream only for the rest. Off-chain metadata changes
    // only when a DRep updates it, which is rare, so a name resolved once is good for an hour. On
    // a full page of a list whose names were fetched moments ago, this drops the /drep_metadata
    // round trip entirely.
    //
    // The cache is read directly rather than through `cache.read(load)`, because the load here is
    // a *batch*: one upstream call resolves many DReps at once, so the fetch cannot be expressed
    // as one loader per key. So this is a plain get, and a plain set once the batch returns.
    const missing: string[] = []
    for (const id of drepIds) {
      const hex = drepCredentialHex(id)
      if (hex === undefined) continue
      const cached = metadataCache.peek(hex)
      if (cached !== undefined) byHex.set(hex, cached)
      else missing.push(id)
    }
    if (missing.length === 0) return byHex

    const toBody = (chunk: string[]): unknown => ({ _drep_ids: chunk })
    for (const chunk of packBySize(missing, toBody, koios.bodyLimit)) {
      try {
        const rows = await koios.batch(z.array(drepMetadataRow), '/drep_metadata', toBody(chunk))
        for (const row of rows) {
          const hex = drepCredentialHex(row.drep_id)
          if (hex === undefined) continue
          const fields = drepMetaFields(row.meta_json)
          byHex.set(hex, fields)
          metadataCache.set(hex, fields)
        }
      } catch {
        // Names for this chunk are simply unavailable. The DReps still resolve, and nothing is
        // cached for them, so the next request tries again rather than caching the gap.
        continue
      }
    }
    return byHex
  }

  // Hydrate a set of drep ids with full drep_info, plus best-effort off-chain name/image.
  // Preserves the input order; unknown ids are absent, so the result is never longer than
  // the input.
  //
  // Batched against Koios's body limit, for the same reason as pool_info: an oversized body is a
  // 413.
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
        const rows = await koios.batchAll(drepInfoRow, '/drep_info', drepIds, (chunk) => ({
          _drep_ids: chunk,
        }))
        return new Map(rows.map((row) => [row.hex.toLowerCase(), row]))
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
      //
      // With a cache: read the whole membership once and slice from it, because page one of a
      // cached list must already contain the ids page two will need. Caching per (offset, limit)
      // would cache each page and rescan for every cold one, which is exactly the trap the pool
      // list fell into.
      //
      // Without a cache: keep the early-exit, reading only far enough to serve this page. Reading
      // the whole list on every request, with nowhere to keep it, would be strictly worse than
      // the bounded walk it replaced.
      const registered = caching
        ? await cache.read(
            'gov:drep-membership',
            { ttlMs: DREP_MEMBERSHIP_TTL_MS, staleIfErrorMs: DREP_MEMBERSHIP_STALE_MS },
            () => registeredDreps(Number.POSITIVE_INFINITY),
          )
        : await registeredDreps(offset + limit)
      const page = registered.slice(offset, offset + limit)

      // /drep_list said these were registered, but /drep_info is a second round trip and a
      // DRep can deregister in between. This endpoint promises registered DReps, so anything
      // whose hydrated status disagrees is dropped rather than served under a claim that is
      // no longer true.
      const hydrated = await drepInfoByIds(page)
      return hydrated.filter((drep) => drep.status === 'registered')
    },
    async getProposals({ limit, offset }: ProposalListParams): Promise<Proposal[]> {
      // Newest first: a governance browser opens on what is happening now, not on what happened in
      // the first week of Conway. Ordered upstream on the proposal's own block time, which is a
      // numeric column, so unlike the pool ranking this sort *can* be pushed down.
      const query = new URLSearchParams({
        order: 'block_time.desc',
        limit: String(limit),
        offset: String(offset),
      })
      const rows = await koios.get(z.array(proposalRow), `/proposal_list?${query.toString()}`)
      if (rows.length === 0) return []

      // The tallies, fetched per proposal and concurrently. A proposal without its votes is not
      // something a user can act on: "should I vote?" is answered by where the vote currently
      // sits, not by the text alone.
      //
      // Best-effort, and deliberately so. A missing tally costs a client a progress bar; a failed
      // tally lookup taking down the whole proposal list would cost it the governance screen.
      const tallies = await Promise.all(
        rows.map(async (row) => {
          try {
            const summary = await koios.get(
              z.array(votingSummaryRow),
              `/proposal_voting_summary?_proposal_id=${encodeURIComponent(row.proposal_id)}`,
            )
            return summary[0]
          } catch {
            return undefined
          }
        }),
      )

      return rows.map((row, i) => {
        const { status, decidedEpoch } = proposalStatus(row)
        const votes = tallies[i]
        const meta = proposalMeta(row.meta_json)

        return {
          proposalId: row.proposal_id,
          txHash: row.proposal_tx_hash,
          index: row.proposal_index,
          type: row.proposal_type,
          status,
          proposedEpoch: row.proposed_epoch,
          ...(row.expiration == null ? {} : { expiryEpoch: row.expiration }),
          ...(decidedEpoch === undefined ? {} : { decidedEpoch }),
          deposit: String(row.deposit),
          returnAddress: row.return_address,
          ...meta,
          ...(row.meta_url == null ? {} : { metadataUrl: row.meta_url }),
          ...(row.meta_hash == null ? {} : { metadataHash: row.meta_hash }),
          // A proposal's title and abstract are attacker-supplied text that someone reads before
          // voting, so a client has to be able to tell a hash-verified document from an
          // unverified one. Passed through rather than defaulted: "we do not know" is not "no".
          ...(row.meta_is_valid == null ? {} : { metadataValid: row.meta_is_valid }),
          ...(votes === undefined
            ? {}
            : {
                drepVotes: stakeWeightedTally(
                  votes.drep_yes_votes_cast,
                  votes.drep_no_votes_cast,
                  votes.drep_abstain_votes_cast,
                  votes.drep_yes_vote_power,
                  votes.drep_no_vote_power,
                  addNumeric(
                    votes.drep_active_abstain_vote_power,
                    votes.drep_always_abstain_vote_power,
                  ),
                ),
                ...(row.proposal_type === 'TreasuryWithdrawals' ||
                row.proposal_type === 'NewConstitution'
                  ? {}
                  : {
                      poolVotes: stakeWeightedTally(
                        votes.pool_yes_votes_cast,
                        votes.pool_no_votes_cast,
                        votes.pool_abstain_votes_cast,
                        votes.pool_yes_vote_power,
                        votes.pool_no_vote_power,
                        addNumeric(
                          votes.pool_active_abstain_vote_power,
                          votes.pool_passive_always_abstain_vote_power,
                        ),
                      ),
                    }),
                // Constitutional committee members each have one vote. The committee has no
                // franchise on committee updates or a motion of no-confidence, so a zero tally
                // there means "not applicable", not "no one voted". Keep that distinction in
                // the response by omitting the optional field for those action types.
                ...(row.proposal_type === 'NewCommittee' || row.proposal_type === 'NoConfidence'
                  ? {}
                  : {
                      committeeVotes: voteCountTally(
                        votes.committee_yes_votes_cast,
                        votes.committee_no_votes_cast,
                        votes.committee_abstain_votes_cast,
                      ),
                    }),
              }),
        }
      })
    },
  }
}
