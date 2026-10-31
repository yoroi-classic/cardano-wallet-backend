import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const PROJECT_ID = 'preprod-project-id-that-must-not-leak'

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('test server did not bind a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  await Promise.all(servers.splice(0).map(close))
})

describe('Blockfrost integration discovery redirects', () => {
  it('rejects a redirect without forwarding project_id or exposing sensitive details', async () => {
    const targetProjectIds: Array<string | undefined> = []
    const target = createServer((request, response) => {
      targetProjectIds.push(request.headers.project_id as string | undefined)
      response.end(JSON.stringify({ reached: true }))
    })
    servers.push(target)
    const targetOrigin = `http://127.0.0.1:${await listen(target)}`

    const sourceProjectIds: Array<string | undefined> = []
    const source = createServer((request, response) => {
      sourceProjectIds.push(request.headers.project_id as string | undefined)
      response.writeHead(302, { location: `${targetOrigin}/credential-target` })
      response.end()
    })
    servers.push(source)
    const sourceOrigin = `http://127.0.0.1:${await listen(source)}`

    vi.stubEnv('BLOCKFROST_URL', sourceOrigin)
    vi.stubEnv('BLOCKFROST_PROJECT_ID', PROJECT_ID)
    vi.resetModules()
    const { discover } = await import('./integration/support/provider-blockfrost.js')

    let thrown: unknown
    try {
      await discover('/fixture')
    } catch (error) {
      thrown = error
    }

    expect(sourceProjectIds).toEqual([PROJECT_ID])
    expect(targetProjectIds).toEqual([])
    expect(thrown).toBeInstanceOf(Error)
    expect(String(thrown)).toBe('Error: blockfrost discovery request failed for /fixture')
    expect(String(thrown)).not.toContain(PROJECT_ID)
    expect(String(thrown)).not.toContain(targetOrigin)
  })
})
