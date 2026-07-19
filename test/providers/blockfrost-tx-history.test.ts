import { describe, expect, it } from 'vitest'
import { createBlockfrostProvider, type FetchLike } from '../../src/providers/blockfrost/index.js'
import { HISTORY_PAGE_SIZE } from '../../src/providers/blockfrost/tx-info.js'
import { ProviderError } from '../../src/domain/errors.js'

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0'
const PROJECT_ID = 'preprodTestProjectId'
const STAKE = 'stake_test1uxaddr'

interface AddrTxRow {
  tx_hash: string
  tx_index: number
  block_height: number
  block_time: number
}

interface TxDef {
  blockHash: string
  blockHeight: number
  blockTime?: number
  slot?: number
  index?: number
  fees?: string
  ttl?: string | null
  inputs?: Record<string, unknown>[]
  outputs?: Record<string, unknown>[]
  withdrawals?: { address: string; amount: string }[]
  stakes?: { cert_index: number; registration: boolean }[]
  delegations?: { cert_index: number }[]
  mirs?: { cert_index: number }[]
  poolUpdates?: { cert_index: number }[]
  poolRetires?: { cert_index: number }[]
  metadata?: { label: string; json_metadata: unknown }[]
}

interface FakeConfig {
  accountAddresses?: Record<string, string[]>
  addressTxs?: Record<string, AddrTxRow[]>
  txs?: Record<string, TxDef>
  blocks?: Record<string, number>
}

const defaultInput = {
  address: 'addr_in',
  amount: [{ unit: 'lovelace', quantity: '2000000' }],
  collateral: false,
  reference: false,
}
const defaultOutput = {
  address: 'addr_out',
  amount: [{ unit: 'lovelace', quantity: '1000000' }],
  output_index: 0,
  data_hash: null,
  inline_datum: null,
  reference_script_hash: null,
  consumed_by_tx: null,
}

/**
 * A Blockfrost fake that answers the whole transaction-hydration fan-out from a compact per-tx
 * definition: `/txs/{hash}`, `/txs/{hash}/utxos`, `/txs/{hash}/metadata`, the certificate
 * sub-resources gated by their counts, and `/blocks/{hash}` for the epoch. It paginates the account
 * addresses and per-address transaction lists the way the real API does, so an off-by-one in either
 * walk shows up here. It records every path so dedup and gating can be asserted.
 */
function buildFake(config: FakeConfig): { fetchImpl: FetchLike; callsTo: (re: RegExp) => number } {
  const calls: string[] = []

  function page<T>(rows: T[], url: URL): T[] {
    const count = Number(url.searchParams.get('count') ?? '100')
    const p = Number(url.searchParams.get('page') ?? '1')
    return rows.slice((p - 1) * count, p * count)
  }

  function txContent(hash: string, def: TxDef): unknown {
    return {
      hash,
      block: def.blockHash,
      block_height: def.blockHeight,
      block_time: def.blockTime ?? 100,
      slot: def.slot ?? 1000,
      index: def.index ?? 0,
      output_amount: [],
      fees: def.fees ?? '170000',
      deposit: '0',
      size: 1,
      invalid_before: null,
      invalid_hereafter: def.ttl === undefined ? null : def.ttl,
      utxo_count: 2,
      withdrawal_count: (def.withdrawals ?? []).length,
      mir_cert_count: (def.mirs ?? []).length,
      delegation_count: (def.delegations ?? []).length,
      stake_cert_count: (def.stakes ?? []).length,
      pool_update_count: (def.poolUpdates ?? []).length,
      pool_retire_count: (def.poolRetires ?? []).length,
    }
  }

  const fetchImpl: FetchLike = async (rawUrl) => {
    const url = new URL(rawUrl)
    const path = url.pathname
    calls.push(path)
    const ok = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => '',
    })
    const notFound = () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
    })

    let m: RegExpMatchArray | null
    if ((m = path.match(/\/accounts\/([^/]+)\/addresses$/))) {
      const list = config.accountAddresses?.[m[1]!]
      if (list === undefined) return notFound()
      return ok(
        page(
          list.map((address) => ({ address })),
          url,
        ),
      )
    }
    if ((m = path.match(/\/addresses\/([^/]+)\/transactions$/))) {
      const rows = config.addressTxs?.[m[1]!]
      if (rows === undefined) return notFound()
      return ok(page(rows, url))
    }
    if ((m = path.match(/\/txs\/([^/]+)\/utxos$/))) {
      const def = config.txs?.[m[1]!]
      if (def === undefined) return notFound()
      return ok({
        hash: m[1],
        inputs: def.inputs ?? [defaultInput],
        outputs: def.outputs ?? [defaultOutput],
      })
    }
    if ((m = path.match(/\/txs\/([^/]+)\/metadata$/))) {
      return ok(config.txs?.[m[1]!]?.metadata ?? [])
    }
    if ((m = path.match(/\/txs\/([^/]+)\/withdrawals$/)))
      return ok(config.txs?.[m[1]!]?.withdrawals ?? [])
    if ((m = path.match(/\/txs\/([^/]+)\/stakes$/))) return ok(config.txs?.[m[1]!]?.stakes ?? [])
    if ((m = path.match(/\/txs\/([^/]+)\/delegations$/)))
      return ok(config.txs?.[m[1]!]?.delegations ?? [])
    if ((m = path.match(/\/txs\/([^/]+)\/mirs$/))) return ok(config.txs?.[m[1]!]?.mirs ?? [])
    if ((m = path.match(/\/txs\/([^/]+)\/pool_updates$/)))
      return ok(config.txs?.[m[1]!]?.poolUpdates ?? [])
    if ((m = path.match(/\/txs\/([^/]+)\/pool_retires$/)))
      return ok(config.txs?.[m[1]!]?.poolRetires ?? [])
    if ((m = path.match(/\/txs\/([^/]+)$/))) {
      const def = config.txs?.[m[1]!]
      if (def === undefined) return notFound()
      return ok(txContent(m[1]!, def))
    }
    if ((m = path.match(/\/blocks\/([^/]+)$/))) {
      const epoch = config.blocks?.[m[1]!]
      if (epoch === undefined) return notFound()
      return ok({
        time: 1,
        height: 1,
        hash: m[1],
        slot: 1,
        epoch,
        slot_leader: 'x',
        size: 1,
        tx_count: 1,
        output: null,
        fees: null,
        block_vrf: null,
        op_cert: null,
        op_cert_counter: null,
        previous_block: null,
        next_block: null,
        confirmations: 1,
      })
    }
    throw new Error(`fake has no route for ${path}`)
  }

  return { fetchImpl, callsTo: (re) => calls.filter((c) => re.test(c)).length }
}

function provider(config: FakeConfig, opts: Record<string, unknown> = {}) {
  const { fetchImpl, callsTo } = buildFake(config)
  return {
    provider: createBlockfrostProvider({
      baseUrl: BASE,
      projectId: PROJECT_ID,
      fetchImpl,
      ...opts,
    }),
    callsTo,
  }
}

// A full-detail two-transaction fixture mirroring the Koios getTxHistory regression, so the mapped
// WalletTransaction can be asserted field-for-field identical to what the Koios driver returns.
const HISTORY_CONFIG: FakeConfig = {
  accountAddresses: { [STAKE]: ['addr_a'] },
  addressTxs: {
    addr_a: [
      { tx_hash: 'aa', tx_index: 1, block_height: 10, block_time: 100 },
      { tx_hash: 'bb', tx_index: 0, block_height: 9, block_time: 90 },
    ],
  },
  blocks: { h9: 1, h10: 1 },
  txs: {
    bb: {
      blockHash: 'h9',
      blockHeight: 9,
      blockTime: 90,
      slot: 900,
      index: 0,
      fees: '150000',
      ttl: '999',
      inputs: [
        {
          address: 'addr_in',
          amount: [{ unit: 'lovelace', quantity: '5000000' }],
          collateral: false,
          reference: false,
        },
      ],
      outputs: [
        {
          address: 'addr_out',
          amount: [
            { unit: 'lovelace', quantity: '4800000' },
            { unit: `${'d'.repeat(56)}4142`, quantity: '3' },
          ],
          output_index: 0,
          data_hash: null,
          inline_datum: null,
          reference_script_hash: null,
          consumed_by_tx: null,
        },
      ],
      withdrawals: [{ address: 'stake_w', amount: '250000' }],
      delegations: [{ cert_index: 0 }],
    },
    aa: {
      blockHash: 'h10',
      blockHeight: 10,
      blockTime: 100,
      slot: 1000,
      index: 1,
      fees: '170000',
      ttl: null,
      inputs: [],
      outputs: [
        {
          address: 'addr_out',
          amount: [{ unit: 'lovelace', quantity: '1000000' }],
          output_index: 0,
          data_hash: null,
          inline_datum: null,
          reference_script_hash: null,
          consumed_by_tx: null,
        },
      ],
      metadata: [{ label: '674', json_metadata: { msg: ['hi'] } }],
    },
  },
}

describe('blockfrost getTxHistory — hydration parity', () => {
  it('enumerates account addresses, then details and maps transactions oldest-first', async () => {
    const { provider: p } = provider(HISTORY_CONFIG)

    const history = await p.getTxHistory(STAKE)

    expect(history.map((t) => t.txHash)).toEqual(['bb', 'aa'])
    expect(history[0]).toEqual({
      txHash: 'bb',
      block: 9,
      blockHash: 'h9',
      slot: 900,
      epoch: 1,
      blockTime: 90,
      fee: '150000',
      ttl: 999,
      inputs: [{ address: 'addr_in', value: '5000000', assets: [] }],
      outputs: [
        {
          address: 'addr_out',
          value: '4800000',
          assets: [{ policyId: 'd'.repeat(56), assetName: '4142', quantity: '3' }],
        },
      ],
      withdrawals: [{ stakeAddress: 'stake_w', amount: '250000' }],
      certificates: [{ kind: 'stake_delegation', index: 0 }],
      metadata: undefined,
    })
    expect(history[1]?.metadata).toEqual({ '674': { msg: ['hi'] } })
  })

  it('returns an empty history for a stake key never seen on chain, without hydrating', async () => {
    const { provider: p, callsTo } = provider({ accountAddresses: {} })

    await expect(p.getTxHistory('stake_test1unknown')).resolves.toEqual([])
    expect(callsTo(/\/txs\//)).toBe(0)
  })

  it('drops collateral and reference inputs, keeping only real spends', async () => {
    const config: FakeConfig = {
      accountAddresses: { [STAKE]: ['addr_a'] },
      addressTxs: { addr_a: [{ tx_hash: 'cc', tx_index: 0, block_height: 5, block_time: 50 }] },
      blocks: { hc: 3 },
      txs: {
        cc: {
          blockHash: 'hc',
          blockHeight: 5,
          inputs: [
            {
              address: 'real',
              amount: [{ unit: 'lovelace', quantity: '9000000' }],
              collateral: false,
              reference: false,
            },
            {
              address: 'coll',
              amount: [{ unit: 'lovelace', quantity: '5000000' }],
              collateral: true,
              reference: false,
            },
            {
              address: 'ref',
              amount: [{ unit: 'lovelace', quantity: '4000000' }],
              collateral: false,
              reference: true,
            },
          ],
        },
      },
    }
    const { provider: p } = provider(config)

    const [tx] = await p.getTxHistory(STAKE)

    expect(tx?.inputs).toEqual([{ address: 'real', value: '9000000', assets: [] }])
  })

  it('maps every certificate kind, ordered by certificate index', async () => {
    const config: FakeConfig = {
      accountAddresses: { [STAKE]: ['addr_a'] },
      addressTxs: { addr_a: [{ tx_hash: 'dd', tx_index: 0, block_height: 7, block_time: 70 }] },
      blocks: { hd: 4 },
      txs: {
        dd: {
          blockHash: 'hd',
          blockHeight: 7,
          stakes: [
            { cert_index: 3, registration: true },
            { cert_index: 4, registration: false },
          ],
          delegations: [{ cert_index: 1 }],
          mirs: [{ cert_index: 0 }],
          poolUpdates: [{ cert_index: 2 }],
          poolRetires: [{ cert_index: 5 }],
        },
      },
    }
    const { provider: p } = provider(config)

    const [tx] = await p.getTxHistory(STAKE)

    expect(tx?.certificates).toEqual([
      { kind: 'move_instantaneous_rewards', index: 0 },
      { kind: 'stake_delegation', index: 1 },
      { kind: 'pool_registration', index: 2 },
      { kind: 'stake_registration', index: 3 },
      { kind: 'stake_deregistration', index: 4 },
      { kind: 'pool_retirement', index: 5 },
    ])
  })

  it('does not fetch a certificate sub-resource when its count is zero', async () => {
    const { provider: p, callsTo } = provider(HISTORY_CONFIG)

    await p.getTxHistory(STAKE)

    // aa has no certificates at all, bb has only a delegation; nothing should touch /stakes etc.
    expect(callsTo(/\/stakes$/)).toBe(0)
    expect(callsTo(/\/pool_retires$/)).toBe(0)
    expect(callsTo(/\/delegations$/)).toBe(1)
  })
})

describe('blockfrost getTxHistoryByAddresses', () => {
  it('collapses a transaction touching several addresses to one hydrated row', async () => {
    const rowAA = { tx_hash: 'aa', tx_index: 1, block_height: 10, block_time: 100 }
    const config: FakeConfig = {
      addressTxs: { addr_a: [rowAA], addr_b: [rowAA] },
      blocks: { h10: 1 },
      txs: { aa: { blockHash: 'h10', blockHeight: 10 } },
    }
    const { provider: p, callsTo } = provider(config)

    const history = await p.getTxHistoryByAddresses(['addr_a', 'addr_b'])

    expect(history.map((t) => t.txHash)).toEqual(['aa'])
    // Detailed exactly once despite matching both addresses.
    expect(callsTo(/\/txs\/aa$/)).toBe(1)
  })

  it('reads across more than one page of an address transaction list', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      tx_hash: `${i}`.padStart(64, '0'),
      tx_index: 0,
      block_height: i + 1,
      block_time: i,
    }))
    const txs: Record<string, TxDef> = {}
    for (const r of rows) txs[r.tx_hash] = { blockHash: 'hx', blockHeight: r.block_height }
    const { provider: p } = provider({ addressTxs: { addr_a: rows }, blocks: { hx: 2 }, txs })

    const history = await p.getTxHistoryByAddresses(['addr_a'])

    // 150 rows span two pages; the page cut is HISTORY_PAGE_SIZE, oldest-first, so the first 50.
    expect(history).toHaveLength(HISTORY_PAGE_SIZE)
    expect(history[0]?.block).toBe(1)
    expect(history[HISTORY_PAGE_SIZE - 1]?.block).toBe(HISTORY_PAGE_SIZE)
  })

  it('extends the page past HISTORY_PAGE_SIZE to include the whole boundary block', async () => {
    // Fifty transactions in distinct blocks, then two more sharing the 50th block. The page cannot
    // stop mid-block, so both boundary-block transactions are included and the page is 51 long.
    const rows: AddrTxRow[] = []
    for (let i = 1; i <= HISTORY_PAGE_SIZE; i += 1) {
      rows.push({ tx_hash: `a${i}`, tx_index: 0, block_height: i, block_time: i })
    }
    rows.push({
      tx_hash: 'a-extra',
      tx_index: 1,
      block_height: HISTORY_PAGE_SIZE,
      block_time: HISTORY_PAGE_SIZE,
    })
    const txs: Record<string, TxDef> = {}
    for (const r of rows)
      txs[r.tx_hash] = { blockHash: 'hb', blockHeight: r.block_height, index: r.tx_index }
    const { provider: p } = provider({ addressTxs: { addr_a: rows }, blocks: { hb: 6 }, txs })

    const history = await p.getTxHistoryByAddresses(['addr_a'])

    expect(history).toHaveLength(HISTORY_PAGE_SIZE + 1)
  })

  it('excludes transactions at or before afterBlock', async () => {
    const config: FakeConfig = {
      addressTxs: {
        addr_a: [
          { tx_hash: 'old', tx_index: 0, block_height: 5, block_time: 5 },
          { tx_hash: 'boundary', tx_index: 0, block_height: 8, block_time: 8 },
          { tx_hash: 'new', tx_index: 0, block_height: 9, block_time: 9 },
        ],
      },
      blocks: { hb: 1 },
      txs: {
        old: { blockHash: 'hb', blockHeight: 5 },
        boundary: { blockHash: 'hb', blockHeight: 8 },
        new: { blockHash: 'hb', blockHeight: 9 },
      },
    }
    const { provider: p } = provider(config)

    const history = await p.getTxHistoryByAddresses(['addr_a'], 8)

    expect(history.map((t) => t.txHash)).toEqual(['new'])
  })

  it('returns an empty array without any request for an empty address set', async () => {
    let called = false
    const fetchImpl: FetchLike = async () => {
      called = true
      return { ok: true, status: 200, json: async () => [], text: async () => '' }
    }
    const p = createBlockfrostProvider({ baseUrl: BASE, projectId: PROJECT_ID, fetchImpl })

    await expect(p.getTxHistoryByAddresses([])).resolves.toEqual([])
    expect(called).toBe(false)
  })

  it('surfaces a loud error when a listed transaction has since rolled back', async () => {
    // The address lists tx 'gone', but detailing it 404s: a hole, which must fail rather than
    // silently drop the transaction, matching the Koios hydration's fail-closed contract.
    const config: FakeConfig = {
      addressTxs: { addr_a: [{ tx_hash: 'gone', tx_index: 0, block_height: 3, block_time: 3 }] },
      blocks: {},
      txs: {},
    }
    const { provider: p } = provider(config)

    await expect(p.getTxHistoryByAddresses(['addr_a'])).rejects.toBeInstanceOf(ProviderError)
  })
})
