import type { FastifyInstance } from 'fastify'
import type { ProtocolParams, Tip } from '../../domain/types.js'
import type { ChainProvider } from '../../providers/provider.js'

/**
 * Chain-level reads. Handlers stay thin: they call the provider and return the
 * normalized shape. Any provider error bubbles up to the server's error handler,
 * which maps it to a stable status code and body.
 */
export function registerChainRoutes(app: FastifyInstance, provider: ChainProvider): void {
  app.get('/v1/chain/tip', async () => toTipResponse(await provider.getTip()))
  app.get('/v1/chain/protocol-params', async () =>
    toProtocolParamsResponse(await provider.getProtocolParams()),
  )
}

function toTipResponse(tip: Tip): Tip {
  return {
    block: tip.block,
    slot: tip.slot,
    epoch: tip.epoch,
    hash: tip.hash,
  }
}

function toProtocolParamsResponse(params: ProtocolParams): ProtocolParams {
  return {
    epoch: params.epoch,
    minFeeA: params.minFeeA,
    minFeeB: params.minFeeB,
    maxTxSize: params.maxTxSize,
    maxBlockBodySize: params.maxBlockBodySize,
    keyDeposit: params.keyDeposit,
    poolDeposit: params.poolDeposit,
    minPoolCost: params.minPoolCost,
    coinsPerUtxoByte: params.coinsPerUtxoByte,
    maxValueSize: params.maxValueSize,
    collateralPercent: params.collateralPercent,
    maxCollateralInputs: params.maxCollateralInputs,
    priceMem: params.priceMem,
    priceStep: params.priceStep,
    maxTxExMem: params.maxTxExMem,
    maxTxExSteps: params.maxTxExSteps,
    protocolVersion: {
      major: params.protocolVersion.major,
      minor: params.protocolVersion.minor,
    },
    costModels: params.costModels ?? {},
  }
}
