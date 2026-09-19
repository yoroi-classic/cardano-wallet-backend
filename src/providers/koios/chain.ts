import { z } from 'zod'
import type { ProtocolParams, Tip } from '../../domain/types/chain.js'
import type { ChainCapability } from '../capabilities/chain.js'
import type { KoiosClient } from './client.js'
import { numeric } from './schema.js'

// Chain counters enter the Tip domain shape as numbers, so anything outside JavaScript's exact
// integer range is already unrecoverably rounded by JSON.parse and must be rejected upstream.
const tipCounter = z.number().int().nonnegative().safe()

const tipRow = z.object({
  hash: z.string(),
  epoch_no: tipCounter,
  abs_slot: tipCounter,
  block_no: tipCounter,
  // Unix seconds. See Tip.blockTime: a slot is not a timestamp.
  block_time: z.number().int().nonnegative(),
})

// Counts, sizes, and the fee coefficients are all whole and non-negative. min_fee_a and
// min_fee_b are lovelace-denominated fee coefficients, but they are small by construction
// (44 and 155381 today) and the wallet's fee arithmetic wants them as numbers, so they
// stay numeric rather than becoming strings like the lovelace *amounts* below. Bounding
// them here means a negative or fractional fee coefficient is malformed upstream data,
// not something we hand to a transaction builder.
const wholeNonNegative = z.number().int().nonnegative()

// Ratios Koios reports as decimals. They are fractions, never money.
const ratio = z.number().nonnegative()

const epochParamsRow = z.object({
  epoch_no: wholeNonNegative,
  min_fee_a: wholeNonNegative,
  min_fee_b: wholeNonNegative,
  max_tx_size: wholeNonNegative,
  max_block_size: wholeNonNegative,
  key_deposit: numeric,
  pool_deposit: numeric,
  min_pool_cost: numeric,
  coins_per_utxo_size: numeric,
  max_val_size: wholeNonNegative,
  collateral_percent: wholeNonNegative,
  max_collateral_inputs: wholeNonNegative,
  price_mem: ratio,
  price_step: ratio,
  max_tx_ex_mem: numeric,
  max_tx_ex_steps: numeric,
  protocol_major: wholeNonNegative,
  protocol_minor: wholeNonNegative,
  cost_models: z.record(z.string(), z.unknown()).nullish(),
})

export function createChainMethods(koios: KoiosClient): ChainCapability {
  return {
    async getTip(): Promise<Tip> {
      const row = await koios.getFirst(tipRow, '/tip')
      return {
        block: row.block_no,
        slot: row.abs_slot,
        epoch: row.epoch_no,
        hash: row.hash,
        blockTime: row.block_time,
      }
    },

    async getProtocolParams(): Promise<ProtocolParams> {
      const row = await koios.getFirst(epochParamsRow, '/epoch_params?order=epoch_no.desc&limit=1')
      return {
        epoch: row.epoch_no,
        minFeeA: row.min_fee_a,
        minFeeB: row.min_fee_b,
        maxTxSize: row.max_tx_size,
        maxBlockBodySize: row.max_block_size,
        keyDeposit: String(row.key_deposit),
        poolDeposit: String(row.pool_deposit),
        minPoolCost: String(row.min_pool_cost),
        coinsPerUtxoByte: String(row.coins_per_utxo_size),
        maxValueSize: row.max_val_size,
        collateralPercent: row.collateral_percent,
        maxCollateralInputs: row.max_collateral_inputs,
        priceMem: row.price_mem,
        priceStep: row.price_step,
        maxTxExMem: String(row.max_tx_ex_mem),
        maxTxExSteps: String(row.max_tx_ex_steps),
        protocolVersion: { major: row.protocol_major, minor: row.protocol_minor },
        costModels: row.cost_models ?? {},
      }
    },
  }
}
