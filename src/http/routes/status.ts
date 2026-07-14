import type { FastifyInstance } from 'fastify'
import type { ChainProvider } from '../../providers/provider.js'

/** How far behind the tip may fall before we call the chain data stale rather than healthy. */
const STALE_TIP_SECONDS = 300

export interface StatusInfo {
  /** Service version, so a client can tell which build it is talking to. */
  version: string
  /** The Cardano network this instance serves. A wallet pointed at the wrong one must find out. */
  network: string
  /** Which upstream chain-data provider is behind it. */
  provider: string
}

/**
 * Client-facing status. Distinct from `/health`, and the distinction matters:
 *
 * `/health` is liveness for the orchestrator. It makes no upstream calls and answers instantly,
 * because a load balancer asking "is this process alive" must not be told "no" merely because
 * Koios is slow. Tying the two together is how a wobbling upstream gets your whole fleet
 * restarted.
 *
 * This endpoint is the opposite: it is for the wallet, and the wallet's question is "can I trust
 * what you are about to tell me". So it does reach upstream, and it reports what it found.
 *
 * It answers 200 even when the chain data is unavailable, with `chain: "down"`. That is not
 * papering over a failure: a client needs to tell "the backend is unreachable" (show a network
 * error) apart from "the backend is fine but its chain source is not" (show a maintenance
 * notice), and a 5xx here would collapse those two into one. The tip read is cached, so a client
 * polling this costs nothing upstream.
 */
export function registerStatusRoutes(
  app: FastifyInstance,
  provider: ChainProvider,
  info: StatusInfo,
): void {
  app.get('/v1/status', async () => {
    try {
      const tip = await provider.getTip()

      // From the block's own timestamp, not from its slot. A slot is not a unix time: converting
      // one needs the era boundaries of the network you happen to be on, and getting that wrong
      // produces a plausible number rather than an error, which is the worst kind of wrong.
      const behindSeconds = Math.max(0, Math.floor(Date.now() / 1000) - tip.blockTime)

      return {
        ...info,
        // 'ok' means the chain data is fresh enough to build a transaction against. 'stale' means
        // we can reach the provider but it is lagging, which is a real state and one a wallet
        // should be told about rather than left to infer from a suspiciously old block.
        chain: behindSeconds <= STALE_TIP_SECONDS ? 'ok' : 'stale',
        behindSeconds,
        tip: { block: tip.block, slot: tip.slot, epoch: tip.epoch, hash: tip.hash },
      }
    } catch {
      // Deliberately swallowed. The upstream error is already logged by the provider; what the
      // caller needs from this endpoint is the *state*, not the stack trace, and a client that
      // gets a 502 here cannot tell it apart from us being down.
      return { ...info, chain: 'down', tip: null }
    }
  })
}
