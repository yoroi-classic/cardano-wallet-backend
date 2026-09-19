import { describe, expect, it } from 'vitest'
import { integrationProvider } from './support/provider.js'

const provider = integrationProvider()

describe('koios governance (integration)', () => {
  it('returns a neutral page of registered dreps and looks one up by id', async () => {
    const dreps = await provider.getDrepList({ limit: 3, offset: 0 })

    expect(dreps.length).toBeGreaterThan(0)
    expect(dreps.length).toBeLessThanOrEqual(3)
    for (const drep of dreps) {
      expect(drep.drepId).toMatch(/^drep1[0-9a-z]+$/)
      expect(drep.status).toBe('registered')
      expect(BigInt(drep.votingPower)).toBeGreaterThanOrEqual(0n)
    }

    // The list already hydrates via drep_info; confirm the direct lookup agrees.
    const first = dreps[0]?.drepId
    const [byId] = await provider.getDrepInfo([first as string])

    expect(byId?.drepId).toBe(first)
    expect(byId?.hex).toMatch(/^[0-9a-f]{56}$/)
  })
})
