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
    proposal_type: 'TreasuryWithdrawals',
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
  drep_always_abstain_vote_power: '402481959468417',
  pool_yes_votes_cast: 1,
  pool_no_votes_cast: 0,
  pool_abstain_votes_cast: 0,
  pool_yes_vote_power: '5000',
  pool_no_vote_power: '0',
  pool_passive_always_abstain_vote_power: '0',
  committee_yes_votes_cast: 3,
  committee_no_votes_cast: 0,
  committee_abstain_votes_cast: 0,
  ...overrides,
})

/** Routes /proposal_list and /proposal_voting_summary separately, as the real endpoints are. */
function fakeKoios(opts: { proposals?: unknown[]; summary?: unknown[] | 'fail' }): {
  fetchImpl: FetchLike
  calls: string[]
} {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    const path = url.replace(BASE, '').split('?')[0] ?? ''
    calls.push(path)

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
  return { fetchImpl, calls }
}

const provider = (opts: Parameters<typeof fakeKoios>[0]) =>
  createKoiosProvider({ baseUrl: BASE, fetchImpl: fakeKoios(opts).fetchImpl, readAttempts: 1 })

describe('koios getProposals', () => {
  it('maps a proposal with its metadata and vote tallies', async () => {
    const [p] = await provider({}).getProposals({ limit: 20, offset: 0 })

    expect(p).toMatchObject({
      proposalId: GOV_ID,
      index: 0,
      type: 'TreasuryWithdrawals',
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
      abstainPower: '402481959468417',
    })
    expect(p?.poolVotes?.yes).toBe(1)
    expect(p?.committeeVotes?.yes).toBe(3)
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
    expect(p?.type).toBe('TreasuryWithdrawals')
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
    // sort is pushed upstream because block_time is a numeric column, unlike the pool ranking.
    expect(koios.calls[0]).toBe('/proposal_list')
  })
})
