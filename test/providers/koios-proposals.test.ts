import { describe, expect, it } from 'vitest'
import { MalformedUpstreamError } from '../../src/domain/errors.js'
import { createKoiosProvider, type FetchLike } from '../../src/providers/koios/index.js'

const BASE = 'https://preprod.koios.rest/api/v1'
const GOV_ID = 'gov_action1jr0g04rwvdz3rrqpm30vwqd5mnjky8l68v0e3g74t6e5apw6wwfqq37hpcl'

/** Shaped after a live Koios /proposal_list row. */
function proposalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposal_id: GOV_ID,
    proposal_tx_hash: 'a'.repeat(64),
    proposal_index: 0,
    proposal_type: 'InfoAction',
    deposit: '100000000000',
    return_address: 'stake_test1uppy2gm2hqzkwc80em4mlat73j4jyqvzhclrvsu72g9xg4q2yweet',
    proposed_epoch: 297,
    expiration: 304,
    ratified_epoch: null,
    enacted_epoch: null,
    dropped_epoch: null,
    expired_epoch: null,
    meta_url: 'https://example.test/proposal.jsonld',
    meta_hash: 'b'.repeat(64),
    meta_json: { body: { title: 'A proposal', abstract: 'It proposes things.' } },
    meta_is_valid: true,
    ...overrides,
  }
}

const summaryRow = (overrides: Record<string, unknown> = {}) => ({
  drep_yes_votes_cast: 4,
  drep_no_votes_cast: 2,
  drep_abstain_votes_cast: 1,
  drep_yes_vote_power: '9999999999999999999', // over 2^53 on purpose
  drep_no_vote_power: '412587729509084',
  drep_active_abstain_vote_power: '9000000000000000',
  drep_always_abstain_vote_power: '402481959468417',
  pool_yes_votes_cast: 1,
  pool_no_votes_cast: 0,
  pool_abstain_votes_cast: 0,
  pool_yes_vote_power: '5000',
  pool_no_vote_power: '0',
  pool_active_abstain_vote_power: '7',
  pool_passive_always_abstain_vote_power: '0',
  committee_yes_votes_cast: 3,
  committee_no_votes_cast: 1,
  committee_abstain_votes_cast: 3,
  ...overrides,
})

/** Routes /proposal_list and /proposal_voting_summary separately, as the real endpoints are. */
function fakeKoios(opts: { proposals?: unknown[]; summary?: unknown[] | 'fail' }): {
  fetchImpl: FetchLike
  calls: string[]
  urls: string[]
} {
  const calls: string[] = []
  const urls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    const path = url.replace(BASE, '').split('?')[0] ?? ''
    calls.push(path)
    urls.push(url)

    if (path === '/proposal_voting_summary') {
      if (opts.summary === 'fail') {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' }
      }
      return {
        ok: true,
        status: 200,
        json: async () => opts.summary ?? [summaryRow()],
        text: async () => '',
      }
    }

    return {
      ok: true,
      status: 200,
      json: async () => opts.proposals ?? [proposalRow()],
      text: async () => '',
    }
  }
  return { fetchImpl, calls, urls }
}

const provider = (opts: Parameters<typeof fakeKoios>[0]) =>
  createKoiosProvider({ baseUrl: BASE, fetchImpl: fakeKoios(opts).fetchImpl, readAttempts: 1 })

describe('koios getProposals', () => {
  it('maps a proposal with its metadata and vote tallies', async () => {
    const [p] = await provider({}).getProposals({ limit: 20, offset: 0 })

    expect(p).toMatchObject({
      proposalId: GOV_ID,
      index: 0,
      type: 'InfoAction',
      status: 'open',
      proposedEpoch: 297,
      expiryEpoch: 304,
      deposit: '100000000000',
      title: 'A proposal',
      abstract: 'It proposes things.',
      metadataValid: true,
    })
    expect(p?.drepVotes).toEqual({
      yes: 4,
      no: 2,
      abstain: 1,
      // Voting power is lovelace: it exceeds 2^53 and must survive as digits, not as a float.
      yesPower: '9999999999999999999',
      noPower: '412587729509084',
      abstainPower: '9402481959468417',
    })
    expect(p?.poolVotes?.yes).toBe(1)
    expect(p?.poolVotes?.abstainPower).toBe('7')
    expect(p?.committeeVotes).toEqual({ yes: 3, no: 1, abstain: 3 })
    expect(p?.committeeVotes).not.toHaveProperty('yesPower')
  })

  it.each(['NewCommittee', 'NoConfidence'] as const)(
    'omits committee votes for %s, where the committee has no vote',
    async (type) => {
      const [p] = await provider({
        proposals: [proposalRow({ proposal_type: type })],
        summary: [summaryRow()],
      }).getProposals({ limit: 20, offset: 0 })

      expect(p?.type).toBe(type)
      expect(p).not.toHaveProperty('committeeVotes')
      expect(p?.drepVotes?.yes).toBe(4)
      expect(p?.poolVotes?.yes).toBe(1)
    },
  )

  it.each(['TreasuryWithdrawals', 'NewConstitution'] as const)(
    'omits pool votes for %s, where pools have no vote',
    async (type) => {
      const [p] = await provider({
        proposals: [proposalRow({ proposal_type: type })],
        summary: [summaryRow()],
      }).getProposals({ limit: 20, offset: 0 })

      expect(p?.type).toBe(type)
      expect(p).not.toHaveProperty('poolVotes')
    },
  )

  it.each(['ParameterChange', 'HardForkInitiation', 'NoConfidence', 'InfoAction'] as const)(
    'keeps pool votes for %s, where pools can vote',
    async (type) => {
      const [p] = await provider({
        proposals: [proposalRow({ proposal_type: type })],
        summary: [summaryRow()],
      }).getProposals({ limit: 20, offset: 0 })

      expect(p?.poolVotes).toMatchObject({ yes: 1, no: 0, abstain: 0 })
    },
  )

  it.each([
    'ParameterChange',
    'HardForkInitiation',
    'TreasuryWithdrawals',
    'NewConstitution',
  ] as const)('keeps committee votes for %s, where the committee can vote', async (type) => {
    const [p] = await provider({
      proposals: [proposalRow({ proposal_type: type })],
      summary: [summaryRow()],
    }).getProposals({ limit: 20, offset: 0 })

    expect(p?.committeeVotes).toEqual({ yes: 3, no: 1, abstain: 3 })
  })

  // Upstream reports a proposal's fate as four separate nullable epoch fields. Deriving the status
  // here is what stops every client reimplementing the same precedence rules, subtly differently.
  it.each([
    ['open', {}, undefined],
    ['ratified', { ratified_epoch: 300 }, 300],
    ['enacted', { enacted_epoch: 301 }, 301],
    ['dropped', { dropped_epoch: 299 }, 299],
    ['expired', { expired_epoch: 304 }, 304],
  ])('reads %s from the epoch fields', async (status, fields, decided) => {
    const [p] = await provider({ proposals: [proposalRow(fields)] }).getProposals({
      limit: 20,
      offset: 0,
    })

    expect(p?.status).toBe(status)
    expect(p?.decidedEpoch).toBe(decided)
  })

  // A proposal is ratified first and enacted afterwards, so one that reached both is *enacted*.
  // Reading it the other way would report the older state and tell a user a decision had not taken
  // effect when it had.
  it('reports a proposal that was ratified and then enacted as enacted', async () => {
    const [p] = await provider({
      proposals: [proposalRow({ ratified_epoch: 300, enacted_epoch: 301 })],
    }).getProposals({ limit: 20, offset: 0 })

    expect(p?.status).toBe('enacted')
    expect(p?.decidedEpoch).toBe(301)
  })

  // The tally is a nicety; the proposal is not. A failed tally lookup taking down the governance
  // screen would be a bad trade.
  it('still returns the proposal when its vote tally cannot be fetched', async () => {
    const [p] = await provider({ summary: 'fail' }).getProposals({ limit: 20, offset: 0 })

    expect(p?.proposalId).toBe(GOV_ID)
    expect(p?.title).toBe('A proposal')
    expect(p?.drepVotes).toBeUndefined()
  })

  // "We do not know" is not "no". A proposal's title and abstract are attacker-supplied text that
  // someone reads before voting, so a client must be able to tell an unverified document from one
  // whose hash did not match.
  it('passes an unknown metadata validity through as absent, not as false', async () => {
    const [p] = await provider({
      proposals: [proposalRow({ meta_is_valid: null })],
    }).getProposals({ limit: 20, offset: 0 })

    expect(p?.metadataValid).toBeUndefined()
    expect(JSON.parse(JSON.stringify(p))).not.toHaveProperty('metadataValid')
  })

  it('reports metadata that failed its hash check as invalid', async () => {
    const [p] = await provider({
      proposals: [proposalRow({ meta_is_valid: false })],
    }).getProposals({ limit: 20, offset: 0 })

    expect(p?.metadataValid).toBe(false)
  })

  it('survives a proposal with no off-chain metadata at all', async () => {
    const [p] = await provider({
      proposals: [proposalRow({ meta_url: null, meta_hash: null, meta_json: null })],
    }).getProposals({ limit: 20, offset: 0 })

    expect(p?.title).toBeUndefined()
    expect(p?.type).toBe('InfoAction')
  })

  it('rejects a governance action type that is not in the spec', async () => {
    await expect(
      provider({ proposals: [proposalRow({ proposal_type: 'SeizeTreasury' })] }).getProposals({
        limit: 20,
        offset: 0,
      }),
    ).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('returns [] without asking for tallies when there are no proposals', async () => {
    const koios = fakeKoios({ proposals: [] })
    const p = createKoiosProvider({ baseUrl: BASE, fetchImpl: koios.fetchImpl })

    await expect(p.getProposals({ limit: 20, offset: 0 })).resolves.toEqual([])
    expect(koios.calls.filter((c) => c === '/proposal_voting_summary')).toHaveLength(0)
  })

  it('asks upstream for the newest first', async () => {
    const koios = fakeKoios({})
    const p = createKoiosProvider({ baseUrl: BASE, fetchImpl: koios.fetchImpl })

    await p.getProposals({ limit: 20, offset: 0 })

    // A governance browser opens on what is happening now, not on the first week of Conway. The
    // unique id tie-break makes equal-timestamp page boundaries deterministic.
    expect(koios.calls[0]).toBe('/proposal_list')
    expect(new URL(koios.urls[0]!).searchParams.get('order')).toBe(
      'block_time.desc,proposal_id.desc',
    )
  })

  it('retrieves equal-timestamp pages completely and repeatably', async () => {
    const rows = [
      proposalRow({ proposal_id: 'gov_action1newest', block_time: 300 }),
      proposalRow({ proposal_id: 'gov_action1tiea', block_time: 200 }),
      proposalRow({ proposal_id: 'gov_action1tieb', block_time: 200 }),
      proposalRow({ proposal_id: 'gov_action1tiec', block_time: 200 }),
      proposalRow({ proposal_id: 'gov_action1oldest', block_time: 100 }),
    ]
    let listCall = 0
    const fetchImpl: FetchLike = async (rawUrl) => {
      const url = new URL(rawUrl)
      if (url.pathname.endsWith('/proposal_voting_summary')) {
        return {
          ok: true,
          status: 200,
          json: async () => [summaryRow()],
          text: async () => '',
        }
      }

      const order = url.searchParams.get('order')
      const tieDirection = listCall++ % 2 === 0 ? 1 : -1
      const ordered = [...rows].sort((a, b) => {
        const byTime = Number(b['block_time']) - Number(a['block_time'])
        if (byTime !== 0) return byTime
        const byId = String(b['proposal_id']).localeCompare(String(a['proposal_id']))
        // PostgREST may return either tie order when no secondary key is specified. Alternate it
        // between requests so an incomplete order deterministically exposes overlap at a page
        // boundary instead of passing by accident on JavaScript's stable Array.sort.
        return order === 'block_time.desc,proposal_id.desc' ? byId : byId * tieDirection
      })
      const offset = Number(url.searchParams.get('offset'))
      const limit = Number(url.searchParams.get('limit'))
      return {
        ok: true,
        status: 200,
        json: async () => ordered.slice(offset, offset + limit),
        text: async () => '',
      }
    }
    const p = createKoiosProvider({ baseUrl: BASE, fetchImpl, readAttempts: 1 })
    const readAllPages = async (): Promise<string[]> => {
      const pages = await Promise.all([
        p.getProposals({ limit: 2, offset: 0 }),
        p.getProposals({ limit: 2, offset: 2 }),
        p.getProposals({ limit: 2, offset: 4 }),
      ])
      return pages.flat().map((proposal) => proposal.proposalId)
    }

    const expected = [
      'gov_action1newest',
      'gov_action1tiec',
      'gov_action1tieb',
      'gov_action1tiea',
      'gov_action1oldest',
    ]
    const first = await readAllPages()
    const repeated = await readAllPages()

    expect(first).toEqual(expected)
    expect(new Set(first)).toHaveLength(expected.length)
    expect(repeated).toEqual(first)
  })
})
