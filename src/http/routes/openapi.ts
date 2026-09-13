import type { FastifyInstance } from 'fastify'
import { openapi } from '../openapi.js'

/**
 * Serve the API contract from the API itself.
 *
 * A spec that lives only in the repository is a spec that client authors have to go and find, in
 * a codebase they do not work in, at a revision that may not be the one they are talking to.
 * Serving it from the running instance means the contract you fetch is, by construction, the
 * contract that instance implements.
 */
export function registerOpenapiRoutes(app: FastifyInstance): void {
  app.get('/v1/openapi.json', async () => openapi)
}
