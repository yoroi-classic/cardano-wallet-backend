import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { MalformedUpstreamError } from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'

const HEX_A = 'a61261172624e8333ceff098648d90f8e404e2e36d5b5f5985cbd35d'
const HEX_B = 'c1ba49d52822bc4ef30cbf77060251668f1a6ef15ca46d18f76cc758'
const DREP_A = 'drep15cfxz9exyn5rx0807zvxfrvslrjqfchrd4d47kv9e0f46uedqtc'
const DREP_B = 'drep1cxayn4fgy27yaucvhamsvqj3v6835mh3tjjx6x8hdnr4vsxxxxx'
const GOV_ID = 'gov_action1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsq6dmejn'
const GOV_ID2 = 'gov_action1zyx3zyx3zyx3zyx3zyx3zyx3zyx3zyx3zyx3zyx3zyx3zyx3zygsq6dmejn'
const TX1 = '2dd15e0ef6e6a17841cb9541c27724072ce4d4b79b91e58432fbaa32d9572531'
const TX2 = '71317e951b20aa46e9fbf45a46a6e950d5723a481225519655bf6c6033445566'

const GOV_PARAMS = { drep_deposit: '500000000', gov_action_lifetime: '30' }

interface GovScript {
  params?: Record<string, unknown>
  drepDetail?: Record<string, Record<string, unknown> | { status: number }>
  drepMeta?: Record<string, Record<string, unknown> | { status: number }>
  drepListPages?: Record<string, unknown>[][]
  proposalListPages?: Record<string, unknown>[][]
  proposalDetail?: Record<string, Record<string, unknown> | { status: number }>
  proposalMeta?: Record<string, Record<string, unknown> | { status: number }>
}

function ok(body: unknown): {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
} {
  return { ok: true, status: 200, json: async () => body, text: async () => '' }
}

function reply(answer: Record<string, unknown> | { status: number } | undefined) {
  if (answer === undefined) throw new Error('test has no answer')
  if ('status' in answer && typeof answer.status === 'number') {
    return {
      ok: answer.status < 400,
      status: answer.status,
      json: async () => ({}),
      text: async () => '',
    }
  }
  return ok(answer)
}

function providerFor(script: GovScript): ReturnType<typeof createBlockfrostProvider> {
  const fetchImpl: FetchLike = async (url) => {
    const u = new URL(url)
    const p = u.pathname
    const page = Number(u.searchParams.get('page') ?? '1')

    if (p.endsWith('/epochs/latest/parameters')) return ok(script.params ?? GOV_PARAMS)

    let m = p.match(/\/governance\/dreps\/([^/]+)\/metadata$/)
    if (m) return reply(script.drepMeta?.[decodeURIComponent(m[1] as string)])
    m = p.match(/\/governance\/dreps\/([^/]+)$/)
    if (m) return reply(script.drepDetail?.[decodeURIComponent(m[1] as string)])
    if (p.endsWith('/governance/dreps')) return ok((script.drepListPages ?? [])[page - 1] ?? [])

    m = p.match(/\/governance\/proposals\/([^/]+)\/([^/]+)\/metadata$/)
    if (m) return reply(script.proposalMeta?.[`${m[1]}/${m[2]}`])
    m = p.match(/\/governance\/proposals\/([^/]+)\/([^/]+)$/)
    if (m) return reply(script.proposalDetail?.[`${m[1]}/${m[2]}`])
    if (p.endsWith('/governance/proposals'))
      return ok((script.proposalListPages ?? [])[page - 1] ?? [])

    throw new Error(`test has no answer for ${url}`)
  }
  return createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })
}

function drepDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    drep_id: DREP_A,
    hex: HEX_A,
    amount: '2000000',
    has_script: true,
    retired: false,
    expired: false,
    ...over,
  }
}

function drepListItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    drep_id: DREP_A,
    hex: HEX_A,
    amount: '2000000',
    has_script: false,
    retired: false,
    expired: false,
    metadata: null,
    ...over,
  }
}

const DREP_ANCHOR = {
  drep_id: DREP_A,
  hex: HEX_A,
  url: 'https://aaa.xyz/drep.json',
  hash: 'a14a5ad4f36bddc00f92ddb39fd9ac633c0fd43f8bfa57758f9163d10ef916de',
  json_metadata: { body: { givenName: 'Ryan Williams', image: { contentUrl: 'ipfs://face' } } },
  bytes: null,
}

describe('blockfrost governance — getDrepInfo', () => {
  it('maps a registered drep with its best-effort off-chain anchor', async () => {
    const provider = providerFor({
      drepDetail: { [DREP_A]: drepDetail() },
      drepMeta: { [DREP_A]: DREP_ANCHOR },
    })

    const [drep] = await provider.getDrepInfo([DREP_A])

    expect(drep).toEqual({
      drepId: DREP_A,
      hex: HEX_A,
      hasScript: true,
      status: 'registered',
      active: true,
      deposit: '500000000',
      votingPower: '2000000',
      name: 'Ryan Williams',
      image: 'ipfs://face',
      metadataUrl: 'https://aaa.xyz/drep.json',
      metadataHash: 'a14a5ad4f36bddc00f92ddb39fd9ac633c0fd43f8bfa57758f9163d10ef916de',
    })
  })

  it('reports a retired drep as deregistered and an inactive one as active:false', async () => {
    const provider = providerFor({
      drepDetail: { [DREP_A]: drepDetail({ retired: true, expired: true }) },
      drepMeta: { [DREP_A]: { status: 404 } },
    })

    const [drep] = await provider.getDrepInfo([DREP_A])

    expect(drep?.status).toBe('deregistered')
    expect(drep?.active).toBe(false)
    expect(drep?.name).toBeUndefined()
  })

  it('still resolves the drep when its anchor lookup fails, and omits an unknown id in order', async () => {
    const provider = providerFor({
      drepDetail: { [DREP_A]: drepDetail(), [DREP_B]: { status: 404 } },
      drepMeta: { [DREP_A]: { status: 404 } },
    })

    const dreps = await provider.getDrepInfo([DREP_A, DREP_B])

    expect(dreps.map((d) => d.drepId)).toEqual([DREP_A])
    expect(dreps[0]?.votingPower).toBe('2000000')
  })

  // Blockfrost reports the credential in CIP-129 form: a type header plus the 28-byte hash.
  // Measured against live preprod on 2026-09-09, all 98 real rows of the first page were 58 chars,
  // 82 headed 0x22 and 16 headed 0x23, so this is the ordinary case rather than an edge one.
  it('strips the CIP-129 header so both providers publish the same 28-byte credential', async () => {
    const provider = providerFor({
      drepDetail: { [DREP_A]: drepDetail({ hex: `22${HEX_A}`, has_script: false }) },
    })

    const [info] = await provider.getDrepInfo([DREP_A])

    expect(info?.hex).toBe(HEX_A)
  })

  it('strips the script-hash header too, and keeps hasScript', async () => {
    const provider = providerFor({
      drepDetail: { [DREP_A]: drepDetail({ hex: `23${HEX_A}`, has_script: true }) },
    })

    const [info] = await provider.getDrepInfo([DREP_A])

    expect(info?.hex).toBe(HEX_A)
    expect(info?.hasScript).toBe(true)
  })

  // The header and has_script state the same thing, so a disagreement is upstream data we cannot
  // reconcile. Guessing which to believe would publish a credential of the wrong kind.
  it('rejects a CIP-129 header that disagrees with has_script', async () => {
    const provider = providerFor({
      drepDetail: { [DREP_A]: drepDetail({ hex: `23${HEX_A}`, has_script: false }) },
    })

    await expect(provider.getDrepInfo([DREP_A])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  // A bare 28-byte hash still passes, so the driver stays correct if Blockfrost ever reports one.
  it('accepts a bare 28-byte credential unchanged', async () => {
    const provider = providerFor({
      drepDetail: { [DREP_A]: drepDetail({ hex: HEX_A }) },
    })

    const [info] = await provider.getDrepInfo([DREP_A])

    expect(info?.hex).toBe(HEX_A)
  })

  it('throws MalformedUpstreamError on a drep credential that is not 56 hex chars', async () => {
    const provider = providerFor({ drepDetail: { [DREP_A]: drepDetail({ hex: 'nothex' }) } })

    await expect(provider.getDrepInfo([DREP_A])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  // Blockfrost answers 200 for a pseudo-DRep on the detail endpoint, with an empty credential and
  // a real voting power. Confirmed live on preprod 2026-09-09 for both ids. Publishing that row
  // would put an empty string in a field the contract calls the 28-byte credential, so the read
  // drops it, the same answer it already gives for an id Blockfrost does not know.
  it('drops a pseudo-drep rather than publishing an empty credential', async () => {
    const provider = providerFor({
      drepDetail: {
        drep_always_abstain: drepDetail({ drep_id: 'drep_always_abstain', hex: '' }),
      },
    })

    await expect(provider.getDrepInfo(['drep_always_abstain'])).resolves.toEqual([])
  })

  // The bypass is a whitelist of the two known ids, not "anything that is not a drep1". An
  // unrecognized id must still have its credential validated rather than waved through.
  it('still validates the credential of an unrecognized non-drep1 id', async () => {
    const provider = providerFor({
      drepDetail: { weird_id: drepDetail({ drep_id: 'weird_id', hex: 'nothex' }) },
    })

    await expect(provider.getDrepInfo(['weird_id'])).rejects.toBeInstanceOf(MalformedUpstreamError)
  })

  it('returns [] for an empty input', async () => {
    await expect(providerFor({}).getDrepInfo([])).resolves.toEqual([])
  })
})

describe('blockfrost governance — getDrepList', () => {
  // Live Blockfrost sends an *empty* hex for the two pseudo-DReps, not a placeholder. They are
  // dropped after parsing, so the schema has to admit them or the whole page fails on rows we were
  // always going to discard. Both were present on the first live page on 2026-09-09.
  it('drops the pseudo-dreps even though they carry an empty credential', async () => {
    const page = [
      drepListItem({ drep_id: DREP_A, hex: `22${HEX_A}` }),
      drepListItem({ drep_id: 'drep_always_abstain', hex: '' }),
      drepListItem({ drep_id: 'drep_always_no_confidence', hex: '' }),
    ]
    const provider = providerFor({ drepListPages: [page] })

    const dreps = await provider.getDrepList({ limit: 10, offset: 0 })

    expect(dreps.map((d) => d.drepId)).toEqual([DREP_A])
    expect(dreps[0]?.hex).toBe(HEX_A)
  })

  it('returns a neutral page, filtering out retired and pseudo dreps, with inline anchors', async () => {
    const page = [
      drepListItem({
        drep_id: DREP_A,
        hex: HEX_A,
        metadata: { url: 'u', hash: 'h', json_metadata: { name: 'Alpha' } },
      }),
      drepListItem({ drep_id: DREP_B, hex: HEX_B }),
      drepListItem({
        drep_id: 'drep1retired000000000000000000000000000000000000000000',
        hex: 'e'.repeat(56),
        retired: true,
      }),
      drepListItem({ drep_id: 'drep_always_abstain', hex: 'f'.repeat(56) }),
    ]
    const provider = providerFor({ drepListPages: [page] })

    const dreps = await provider.getDrepList({ limit: 10, offset: 0 })

    expect(dreps.map((d) => d.drepId)).toEqual([DREP_A, DREP_B])
    expect(dreps[0]).toMatchObject({
      status: 'registered',
      deposit: '500000000',
      name: 'Alpha',
      metadataUrl: 'u',
    })
  })

  it('honors offset and limit against the registered set', async () => {
    const page = [
      drepListItem({ drep_id: DREP_A, hex: HEX_A }),
      drepListItem({ drep_id: DREP_B, hex: HEX_B }),
    ]
    const provider = providerFor({ drepListPages: [page] })

    const dreps = await provider.getDrepList({ limit: 1, offset: 1 })

    expect(dreps.map((d) => d.drepId)).toEqual([DREP_B])
  })

  it('walks pages when the first does not hold enough registered dreps', async () => {
    const full = Array.from({ length: 100 }, (_v, i) =>
      drepListItem({
        drep_id: `drep1page1n${i}`.padEnd(20, '0'),
        hex: i.toString(16).padStart(56, '0'),
      }),
    )
    const target = drepListItem({ drep_id: DREP_B, hex: HEX_B })
    const provider = providerFor({ drepListPages: [full, [target]] })

    const dreps = await provider.getDrepList({ limit: 1, offset: 100 })

    expect(dreps.map((d) => d.drepId)).toEqual([DREP_B])
  })
})

function proposalDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GOV_ID,
    tx_hash: TX1,
    cert_index: 1,
    governance_type: 'info_action',
    governance_description: { tag: 'InfoAction' },
    deposit: '100000000000',
    return_address: 'stake_test1urd3hs7rlxwwdzthe6hj026dmyt3y0heuulctscyydh2kgck6nkmz',
    ratified_epoch: null,
    enacted_epoch: null,
    dropped_epoch: null,
    expired_epoch: null,
    expiration: 120,
    ...over,
  }
}

const PROPOSAL_ANCHOR = {
  url: 'https://abc.xyz/gov.json',
  hash: 'ffa226f3863aca006172d559cf46bb8b883a47233962ae2fc94c158d7de6fa81',
  json_metadata: { body: { title: 'Hardfork to PV10', abstract: 'Full governance asap' } },
}

describe('blockfrost governance — getProposals', () => {
  it('maps a page newest-first, leaving proposedEpoch absent rather than fabricating it', async () => {
    const provider = providerFor({
      proposalListPages: [
        [{ id: GOV_ID, tx_hash: TX1, cert_index: 1, governance_type: 'info_action' }],
      ],
      proposalDetail: { [`${TX1}/1`]: proposalDetail() },
      proposalMeta: { [`${TX1}/1`]: PROPOSAL_ANCHOR },
    })

    const [proposal] = await provider.getProposals({ limit: 10, offset: 0 })

    expect(proposal).toEqual({
      proposalId: GOV_ID,
      txHash: TX1,
      index: 1,
      type: 'InfoAction',
      status: 'open',
      // No proposedEpoch: Blockfrost cannot source it, so it is left absent (see #3).
      expiryEpoch: 120,
      deposit: '100000000000',
      returnAddress: 'stake_test1urd3hs7rlxwwdzthe6hj026dmyt3y0heuulctscyydh2kgck6nkmz',
      title: 'Hardfork to PV10',
      abstract: 'Full governance asap',
      metadataUrl: 'https://abc.xyz/gov.json',
      metadataHash: 'ffa226f3863aca006172d559cf46bb8b883a47233962ae2fc94c158d7de6fa81',
    })
    expect(proposal?.proposedEpoch).toBeUndefined()
    // No vote tallies: Blockfrost has no vote-summary endpoint.
    expect(proposal?.drepVotes).toBeUndefined()
  })

  it('applies the enacted-over-ratified status precedence and maps the governance type', async () => {
    const provider = providerFor({
      proposalListPages: [
        [{ id: GOV_ID2, tx_hash: TX2, cert_index: 4, governance_type: 'treasury_withdrawals' }],
      ],
      proposalDetail: {
        [`${TX2}/4`]: proposalDetail({
          id: GOV_ID2,
          tx_hash: TX2,
          cert_index: 4,
          governance_type: 'treasury_withdrawals',
          ratified_epoch: 122,
          enacted_epoch: 123,
        }),
      },
      proposalMeta: { [`${TX2}/4`]: { status: 404 } },
    })

    const [proposal] = await provider.getProposals({ limit: 10, offset: 0 })

    expect(proposal?.type).toBe('TreasuryWithdrawals')
    expect(proposal?.status).toBe('enacted')
    expect(proposal?.decidedEpoch).toBe(123)
    // Anchor 404: best-effort, so no title but the proposal still resolves.
    expect(proposal?.title).toBeUndefined()
  })

  it('returns [] for a page past the end of the list', async () => {
    const provider = providerFor({
      proposalListPages: [
        [{ id: GOV_ID, tx_hash: TX1, cert_index: 1, governance_type: 'info_action' }],
      ],
    })

    await expect(provider.getProposals({ limit: 10, offset: 50 })).resolves.toEqual([])
  })
})
