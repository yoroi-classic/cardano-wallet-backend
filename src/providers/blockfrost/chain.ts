import { z } from 'zod'
import type { ProtocolParams, Tip } from '../../domain/types/chain.js'
import type { ChainCapability } from '../capabilities/chain.js'
import type { BlockfrostClient } from './client.js'
import { numeric, smallNumeric } from './schema.js'

/**
 * `block_content`, projected to the fields the tip needs (Blockfrost OpenAPI spec, `/blocks/latest`).
 *
 * The spec marks `height`, `slot`, and `epoch` nullable, to accommodate the handful of very early
 * (pre-Shelley) blocks that lack them. The chain *tip* is never one of those, so these are
 * required here rather than `.nullable()`: a null on this endpoint specifically would mean
 * something is genuinely wrong, and it should fail as malformed rather than quietly reporting a
 * tip with no block number.
 */
const tipRow = z.object({
  height: z.number().int().nonnegative(),
  hash: z.string(),
  slot: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  // Unix seconds. See Tip.blockTime: a slot is not a timestamp.
  time: z.number().int().nonnegative(),
})

/**
 * `epoch_param_content`, projected to the fields ProtocolParams needs (Blockfrost OpenAPI spec,
 * `/epochs/latest/parameters`). Several numeric fields are nullable in the spec to accommodate
 * epochs before the parameter existed (pre-Alonzo, mostly); `/epochs/latest/parameters` always
 * answers for the current live epoch on any network we target, so those are required here too,
 * and a null is treated as a malformed response rather than accepted silently.
 */
const epochParamsRow = z.object({
  epoch: z.number().int().nonnegative(),
  min_fee_a: z.number().int().nonnegative(),
  min_fee_b: z.number().int().nonnegative(),
  max_tx_size: z.number().int().nonnegative(),
  max_block_size: z.number().int().nonnegative(),
  key_deposit: numeric,
  pool_deposit: numeric,
  min_pool_cost: numeric,
  coins_per_utxo_size: numeric,
  // Blockfrost types this one as a numeric string; our domain models it as a plain number.
  max_val_size: smallNumeric,
  collateral_percent: z.number().int().nonnegative(),
  max_collateral_inputs: z.number().int().nonnegative(),
  price_mem: z.number().nonnegative(),
  price_step: z.number().nonnegative(),
  max_tx_ex_mem: numeric,
  max_tx_ex_steps: numeric,
  protocol_major_ver: z.number().int().nonnegative(),
  protocol_minor_ver: z.number().int().nonnegative(),
  // Both nullable per spec, and `cost_models_raw` is not even in the endpoint's required-field
  // list. See the note in getProtocolParams on why that matters.
  cost_models: z.record(z.string(), z.unknown()).nullish(),
  cost_models_raw: z.record(z.string(), z.unknown()).nullish(),
})

export function createChainMethods(client: BlockfrostClient): ChainCapability {
  return {
    async getTip(): Promise<Tip> {
      const row = await client.get(tipRow, '/blocks/latest')
      return {
        block: row.height,
        slot: row.slot,
        epoch: row.epoch,
        hash: row.hash,
        blockTime: row.time,
      }
    },

    async getProtocolParams(): Promise<ProtocolParams> {
      const row = await client.get(epochParamsRow, '/epochs/latest/parameters')
      return {
        epoch: row.epoch,
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
        protocolVersion: { major: row.protocol_major_ver, minor: row.protocol_minor_ver },
        // Prefer `cost_models_raw` (the ledger-CDDL parameter-array form a serialization library
        // actually consumes) over the deprecated `cost_models`, per Blockfrost's own spec note.
        //
        // This is the real gap flagged in issue #4: both fields are nullable, and
        // `cost_models_raw` is not even a required field on this endpoint per Blockfrost's
        // OpenAPI spec (v0.1.90 as of writing). A deployment that omits both — a bare Dingo node
        // running in Blockfrost-emulation mode is the known case — leaves a wallet without the
        // cost models it needs to build or evaluate a script transaction. Default to an empty
        // object rather than throw, matching the Koios driver's own null handling: the rest of
        // protocol params is still good for a plain ADA transfer even when Plutus support isn't.
        costModels: row.cost_models_raw ?? row.cost_models ?? {},
      }
    },
  }
}
