import { z } from 'zod'
import { ProviderError } from '../../domain/errors.js'
import {
  type DrepInfo,
  type DrepListParams,
  type Proposal,
  type ProposalListParams,
  type ProposalStatus,
  type ProposalType,
} from '../../domain/types/governance.js'
import type { GovernanceCapability } from '../capabilities/governance.js'
import type { BlockfrostClient } from './client.js'
import { mapWithConcurrency } from './concurrency.js'
import { collectPages } from './pagination.js'
import { numeric } from './schema.js'

// Bounded fan-out for the per-item hydration Blockfrost forces (no batch DRep or proposal read),
// paced on top by the client's shared rate limiter. Same shape as filterUsedAddresses.
const DREP_LOOKUP_CONCURRENCY = 10
const PROPOSAL_LOOKUP_CONCURRENCY = 8

// Blockfrost's max page size, and a generous cap on how far the registered-DRep walk scans before
// it reports an overrun rather than serving a truncated list.
const DREP_PAGE_SIZE = 100
const DREP_MAX_PAGES = 500

// Blockfrost's governance_type vocabulary mapped onto the domain's ProposalType. Constrained to
// exactly the documented values so an unexpected one is malformed upstream data, not a new action
// type leaking into the contract, the same stance the Koios driver takes.
const BF_GOVERNANCE_TYPES = [
  'hard_fork_initiation',
  'new_committee',
  'new_constitution',
  'info_action',
  'no_confidence',
  'parameter_change',
  'treasury_withdrawals',
] as const

const GOVERNANCE_TYPE: Record<(typeof BF_GOVERNANCE_TYPES)[number], ProposalType> = {
  hard_fork_initiation: 'HardForkInitiation',
  new_committee: 'NewCommittee',
  new_constitution: 'NewConstitution',
  info_action: 'InfoAction',
  no_confidence: 'NoConfidence',
  parameter_change: 'ParameterChange',
  treasury_withdrawals: 'TreasuryWithdrawals',
}

// The one governance knob this driver reads out of `/epochs/latest/parameters`: the current DRep
// registration deposit. Blockfrost's DRep endpoints do not echo the deposit an individual DRep
// actually paid (Koios does), so the protocol's current value stands in for it; see getDrepInfo.
const govParamsRow = z.object({
  drep_deposit: numeric.nullish(),
})

const drepMetaAnchor = z.object({
  url: z.string().nullish(),
  hash: z.string().nullish(),
  // Off-chain CIP-119 JSON, resolved and validated by Blockfrost. Attacker-influenced, walked
  // defensively; null when Blockfrost has not fetched it or it failed validation.
  json_metadata: z.unknown().nullish(),
})

/**
 * CIP-129 credential-type headers for a DRep: `0x22` a key hash, `0x23` a script hash.
 *
 * Blockfrost reports a DRep credential in CIP-129 form, so its `hex` is 29 bytes: the header
 * followed by the 28-byte hash. Koios reports the bare hash. `DrepInfo.hex` is published as the
 * 28-byte credential and documented as identical across both id encodings, so the header is
 * stripped here rather than the contract widened. Widening it would hand a client a different
 * `hex` for the same DRep depending on which provider served it, which is exactly what that field
 * exists not to do.
 */
const DREP_KEY_HASH_HEADER = '22'
const DREP_SCRIPT_HASH_HEADER = '23'

const BARE_CREDENTIAL = /^[0-9a-fA-F]{56}$/
const HEADED_CREDENTIAL = /^([0-9a-fA-F]{2})([0-9a-fA-F]{56})$/

/**
 * Reduce a DRep credential to the 28-byte hash the contract publishes.
 *
 * A bare hash passes through, which keeps this correct if Blockfrost ever reports one. A headed
 * credential is accepted only when the header agrees with the row's own `has_script`: the two say
 * the same thing, so a disagreement is upstream data we cannot reconcile rather than a form to
 * normalize, and guessing which of the two to believe would publish a credential of the wrong
 * kind. Anything else fails, so a truncated or non-hex value still lands on the malformed path.
 */
function normalizeDrepCredential(hex: string, hasScript: boolean, ctx: z.RefinementCtx): string {
  if (BARE_CREDENTIAL.test(hex)) return hex

  const headed = HEADED_CREDENTIAL.exec(hex)
  if (headed === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'drep credential is neither a 28-byte hash nor a CIP-129 headed credential',
    })
    return z.NEVER
  }

  const [, header, credential] = headed
  const expected = hasScript ? DREP_SCRIPT_HASH_HEADER : DREP_KEY_HASH_HEADER
  if (header?.toLowerCase() !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "drep credential header disagrees with the row's has_script flag",
    })
    return z.NEVER
  }
  return credential as string
}

/**
 * Whether a row is one of the two pseudo-DReps (`drep_always_abstain`,
 * `drep_always_no_confidence`). They are voting options rather than registrations, they carry an
 * empty `hex`, and `registeredDreps` drops them. That filter runs on parsed rows, so the schema
 * has to admit them or the page fails before the filter is reached.
 */
const isPseudoDrep = (drepId: string): boolean => !drepId.startsWith('drep1')

/** `drep` (Blockfrost OpenAPI spec, `/governance/dreps/{drep_id}`), projected to what we map. */
const drepRow = z
  .object({
    drep_id: z.string(),
    hex: z.string(),
    amount: numeric,
    has_script: z.boolean(),
    // Registration lifecycle: `true` once the DRep has deregistered.
    retired: z.boolean(),
    // Inactive for `drep_activity` epochs. The domain's `active` is the negation of this.
    expired: z.boolean(),
  })
  .transform((row, ctx) => ({
    ...row,
    hex: isPseudoDrep(row.drep_id)
      ? row.hex
      : normalizeDrepCredential(row.hex, row.has_script, ctx),
  }))

/** One row of `dreps` (`/governance/dreps`). The list carries the anchor inline, unlike the Koios
 * list, so a page needs no second round trip per DRep. */
const drepListRow = z
  .object({
    drep_id: z.string(),
    hex: z.string(),
    amount: numeric,
    has_script: z.boolean(),
    retired: z.boolean(),
    expired: z.boolean(),
    metadata: drepMetaAnchor.nullish(),
  })
  .transform((row, ctx) => ({
    ...row,
    hex: isPseudoDrep(row.drep_id)
      ? row.hex
      : normalizeDrepCredential(row.hex, row.has_script, ctx),
  }))

const proposalListRow = z.object({
  id: z.string().regex(/^gov_action1[0-9a-z]+$/),
  tx_hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  cert_index: z.number().int().nonnegative(),
  governance_type: z.enum(BF_GOVERNANCE_TYPES),
})

/** `proposal` (`/governance/proposals/{tx_hash}/{cert_index}`), projected to what we map. Koios
 * reports a proposal's fate as four nullable epoch fields, and so does Blockfrost. */
const proposalRow = z.object({
  id: z.string().regex(/^gov_action1[0-9a-z]+$/),
  tx_hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  cert_index: z.number().int().nonnegative(),
  governance_type: z.enum(BF_GOVERNANCE_TYPES),
  deposit: numeric,
  return_address: z.string(),
  ratified_epoch: z.number().int().nonnegative().nullish(),
  enacted_epoch: z.number().int().nonnegative().nullish(),
  dropped_epoch: z.number().int().nonnegative().nullish(),
  expired_epoch: z.number().int().nonnegative().nullish(),
  expiration: z.number().int().nonnegative(),
})

const proposalMetadataRow = z.object({
  url: z.string().nullish(),
  hash: z.string().nullish(),
  // Off-chain CIP-108 JSON, resolved by Blockfrost. Attacker-influenced, walked defensively.
  json_metadata: z.unknown().nullish(),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

interface DrepMetaFields {
  name?: string
  image?: string
  metadataUrl?: string
  metadataHash?: string
}

// CIP-119 puts the display name at body.givenName; some DReps use a flatter top-level { name }. Try
// both. The image, when present, is a URL under body.image.contentUrl. Same shape the Koios driver
// reads, because it is the same CIP.
function drepMetaFields(anchor: z.infer<typeof drepMetaAnchor> | null | undefined): DrepMetaFields {
  if (!anchor) return {}
  const metaJson = anchor.json_metadata
  let name: string | undefined
  let image: string | undefined
  if (isRecord(metaJson)) {
    const body = isRecord(metaJson.body) ? metaJson.body : undefined
    name = asString(body?.givenName) ?? asString(metaJson.name)
    image = body && isRecord(body.image) ? asString(body.image.contentUrl) : undefined
  }
  const url = asString(anchor.url)
  const hash = asString(anchor.hash)
  return {
    ...(name ? { name } : {}),
    ...(image ? { image } : {}),
    ...(url ? { metadataUrl: url } : {}),
    ...(hash ? { metadataHash: hash } : {}),
  }
}

function mapDrepInfo(
  row: z.infer<typeof drepRow> | z.infer<typeof drepListRow>,
  deposit: string,
  meta: DrepMetaFields,
): DrepInfo {
  return {
    drepId: row.drep_id,
    hex: row.hex,
    hasScript: row.has_script,
    // Blockfrost has no row for a never-registered DRep (it 404s), so it never produces
    // `not_registered`; a listed or looked-up DRep is registered unless it has retired.
    status: row.retired ? 'deregistered' : 'registered',
    active: !row.expired,
    deposit,
    votingPower: String(row.amount),
    ...meta,
  }
}

/** CIP-108 puts the human-readable parts under `body`. */
function proposalMeta(metaJson: unknown): { title?: string; abstract?: string } {
  if (!isRecord(metaJson)) return {}
  const body = isRecord(metaJson.body) ? metaJson.body : metaJson
  const title = asString(body.title)
  const summary = asString(body.abstract)
  return { ...(title ? { title } : {}), ...(summary ? { abstract: summary } : {}) }
}

/**
 * Where a proposal has got to, from the four nullable epoch fields. Identical precedence to the
 * Koios driver: `enacted` outranks `ratified` because a proposal is ratified first and enacted
 * afterwards, so reading it the other way would report the older state.
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

export function createGovernanceMethods(client: BlockfrostClient): GovernanceCapability {
  // The current DRep registration deposit, read once per request that needs it.
  async function governanceParams(): Promise<{ drepDeposit: string }> {
    const row = await client.get(govParamsRow, '/epochs/latest/parameters')
    return {
      drepDeposit: row.drep_deposit == null ? '0' : String(row.drep_deposit),
    }
  }

  // Off-chain DRep name/image/url/hash, best-effort: a DRep's name is a nicety, its on-chain
  // standing is not, so any failure here returns empty rather than taking down a lookup that
  // otherwise succeeded. That includes a 200 whose body does not match the schema, which is why the
  // whole call is guarded.
  async function drepAnchor(drepId: string): Promise<DrepMetaFields> {
    try {
      const anchor = await client.getOrUndefined(
        drepMetaAnchor,
        `/governance/dreps/${encodeURIComponent(drepId)}/metadata`,
      )
      return drepMetaFields(anchor)
    } catch {
      return {}
    }
  }

  // Read registered DReps in Blockfrost's own (neutral) order, keeping the registered ones, until
  // `needed` are in hand or the list ends. The registered filter is applied here because the list
  // includes deregistered DReps; filtering after an upstream page would hand back short pages. The
  // special always-abstain / always-no-confidence pseudo-DReps (whose ids are not `drep1...`) are
  // dropped too: they are not registrations and have no place in a neutral list of DReps.
  async function registeredDreps(needed: number): Promise<z.infer<typeof drepListRow>[]> {
    const kept: z.infer<typeof drepListRow>[] = []
    for (let page = 1; page <= DREP_MAX_PAGES; page += 1) {
      const rows = await client.get(
        z.array(drepListRow),
        `/governance/dreps?count=${DREP_PAGE_SIZE}&page=${page}`,
      )
      for (const row of rows) {
        if (!row.retired && row.drep_id.startsWith('drep1')) kept.push(row)
      }
      if (rows.length < DREP_PAGE_SIZE) return kept
      if (kept.length >= needed) return kept
    }

    // Full pages all the way to the cap without satisfying `needed`. Probe one more to tell a list
    // that ended on the boundary apart from one genuinely longer than the scan bound.
    const probe = await client.get(
      z.array(drepListRow),
      `/governance/dreps?count=${DREP_PAGE_SIZE}&page=${DREP_MAX_PAGES + 1}`,
    )
    if (probe.length === 0) return kept
    throw new ProviderError(
      `blockfrost /governance/dreps exceeds this provider's ${DREP_MAX_PAGES * DREP_PAGE_SIZE}-row scan bound`,
    )
  }

  function mapProposal(
    row: z.infer<typeof proposalRow>,
    meta: { title?: string; abstract?: string; metadataUrl?: string; metadataHash?: string },
  ): Proposal {
    // `proposedEpoch` is deliberately left absent. Blockfrost exposes no proposed epoch, only the
    // expiration epoch and the *current* `gov_action_lifetime`, and `expiration - lifetime` would
    // be wrong for any proposal submitted while the parameter held a different value. An absent
    // optional field is the honest answer; deriving one from the wrong-era parameter is not. See
    // the note on Proposal.proposedEpoch.
    const { status, decidedEpoch } = proposalStatus(row)
    return {
      proposalId: row.id,
      txHash: row.tx_hash,
      index: row.cert_index,
      type: GOVERNANCE_TYPE[row.governance_type],
      status,
      expiryEpoch: row.expiration,
      ...(decidedEpoch === undefined ? {} : { decidedEpoch }),
      deposit: String(row.deposit),
      returnAddress: row.return_address,
      ...meta,
    }
  }

  // CIP-108 title/abstract plus the anchor url/hash, best-effort for the same reason as the DRep
  // anchor: a missing document costs a client a title, not the whole proposal list.
  async function proposalAnchor(
    txHash: string,
    certIndex: number,
  ): Promise<{ title?: string; abstract?: string; metadataUrl?: string; metadataHash?: string }> {
    try {
      const anchor = await client.getOrUndefined(
        proposalMetadataRow,
        `/governance/proposals/${txHash}/${certIndex}/metadata`,
      )
      if (anchor === undefined) return {}
      const { title, abstract } = proposalMeta(anchor.json_metadata)
      const url = asString(anchor.url)
      const hash = asString(anchor.hash)
      return {
        ...(title ? { title } : {}),
        ...(abstract ? { abstract } : {}),
        ...(url ? { metadataUrl: url } : {}),
        ...(hash ? { metadataHash: hash } : {}),
      }
    } catch {
      return {}
    }
  }

  return {
    async getDrepInfo(drepIds: string[]): Promise<DrepInfo[]> {
      if (drepIds.length === 0) return []
      const { drepDeposit } = await governanceParams()

      // One paced, bounded-concurrency lookup per id. An id Blockfrost has never heard of answers
      // 404 -> `undefined` -> absent, so unknown ids drop out and the result stays in input order
      // and never longer than the input. Blockfrost cannot distinguish "never registered" from
      // "unknown" (both 404), so unlike the Koios driver it never returns `status:
      // 'not_registered'`; such ids are simply absent.
      const mapped = await mapWithConcurrency(drepIds, DREP_LOOKUP_CONCURRENCY, async (id) => {
        const row = await client.getOrUndefined(
          drepRow,
          `/governance/dreps/${encodeURIComponent(id)}`,
        )
        if (row === undefined) return undefined
        const meta = await drepAnchor(id)
        return mapDrepInfo(row, drepDeposit, meta)
      })
      return mapped.filter((drep): drep is DrepInfo => drep !== undefined)
    },

    async getDrepList({ limit, offset }: DrepListParams): Promise<DrepInfo[]> {
      if (limit <= 0) return []
      const { drepDeposit } = await governanceParams()

      // Neutral, unranked page of registered DReps in Blockfrost's own order. No ranking,
      // promotional or otherwise, and no house DRep. The list already carries each DRep's anchor
      // inline, so a page maps straight through with no per-DRep round trip.
      const registered = await registeredDreps(offset + limit)
      return registered
        .slice(offset, offset + limit)
        .map((row) => mapDrepInfo(row, drepDeposit, drepMetaFields(row.metadata)))
    },

    async getProposals({ limit, offset }: ProposalListParams): Promise<Proposal[]> {
      if (limit <= 0) return []

      // Newest first, so a governance browser opens on what is happening now. `order=desc` reverses
      // Blockfrost's chronological default, which the paginator then walks far enough to cover the
      // requested window.
      const list = await collectPages(
        client,
        proposalListRow,
        '/governance/proposals?order=desc',
        offset + limit,
        { label: '/governance/proposals' },
      )
      const page = list.slice(offset, offset + limit)
      if (page.length === 0) return []

      // Hydrate each proposal in the page: the list carries only the id, tx hash, index and type, so
      // the deposit, return address and epoch fields come from the per-proposal detail, and the
      // CIP-108 title/abstract from its anchor. Vote tallies are deliberately not produced: unlike
      // Koios's single voting-summary call, Blockfrost offers only paged individual votes carrying
      // no voting power, so a faithful tally is not reachable and the (optional) tally fields are
      // left absent rather than filled with power-less counts.
      return mapWithConcurrency(page, PROPOSAL_LOOKUP_CONCURRENCY, async (item) => {
        const detail = await client.get(
          proposalRow,
          `/governance/proposals/${item.tx_hash}/${item.cert_index}`,
        )
        const meta = await proposalAnchor(item.tx_hash, item.cert_index)
        return mapProposal(detail, meta)
      })
    },
  }
}
