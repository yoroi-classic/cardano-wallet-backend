import type { FastifyInstance } from 'fastify'
import { FeatureUnavailableError } from '../../domain/errors.js'
import type { RemoteConfig } from '../../remote-config/index.js'

/**
 * Remote configuration for the clients: feature flags, the dApp list, and so on.
 *
 * Replaces the clients' direct fetch of `raw.githubusercontent.com/Emurgo/yoroi-config`, and the
 * point is not the endpoint, it is *whose file it is*. Whoever controls that document controls
 * what our users see: a banner, the dApp list, or nothing at all if it is deleted. It is now our
 * fork, and the wallet asks us rather than a host we do not control.
 *
 * It also stops a wallet handing its IP to GitHub on every launch, which would be an odd thing to
 * allow given we go to some trouble not to write that down ourselves (src/http/logging.ts).
 *
 * The document is served exactly as published. No transformation, because a config endpoint that
 * rewrites config becomes a second place to look when a client misbehaves, and nobody remembers
 * to look in two places. The Emurgo banners are already switched off in the fork, which is where
 * a content decision belongs.
 */
export function registerConfigRoutes(app: FastifyInstance, config: RemoteConfig | undefined): void {
  app.get('/v1/config', async () => {
    if (config === undefined) {
      throw new FeatureUnavailableError(
        'remote config is not enabled on this deployment (CONFIG_URL is unset)',
      )
    }
    return config.get()
  })
}
