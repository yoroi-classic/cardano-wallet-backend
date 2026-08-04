import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/index.js'
import { createProvider } from '../../src/providers/factory.js'
import { ConfigError } from '../../src/domain/errors.js'

describe('loadConfig — happy path', () => {
  it('applies preprod defaults when the env is empty', () => {
    const config = loadConfig({})

    expect(config.network).toBe('preprod')
    expect(config.provider).toBe('koios')
    expect(config.port).toBe(3010)
    expect(config.koios.url).toBe('https://preprod.koios.rest/api/v1')
    expect(config.koios.token).toBeUndefined()
    expect(config.trustedProxies).toEqual([])
  })

  it('picks the mainnet Koios url when NETWORK is mainnet', () => {
    const config = loadConfig({ NETWORK: 'mainnet' })
    expect(config.koios.url).toBe('https://api.koios.rest/api/v1')
  })

  it('honors an explicit KOIOS_URL and a non-empty token', () => {
    const config = loadConfig({ KOIOS_URL: 'https://koios.example/api/v1', KOIOS_TOKEN: 'tok' })
    expect(config.koios.url).toBe('https://koios.example/api/v1')
    expect(config.koios.token).toBe('tok')
  })

  it('treats an empty token as absent', () => {
    const config = loadConfig({ KOIOS_TOKEN: '' })
    expect(config.koios.token).toBeUndefined()
  })

  it('coerces PORT from a string', () => {
    const config = loadConfig({ PORT: '4000' })
    expect(config.port).toBe(4000)
  })

  it('picks the default Blockfrost url per network', () => {
    expect(loadConfig({}).blockfrost.url).toBe('https://cardano-preprod.blockfrost.io/api/v0')
    expect(loadConfig({ NETWORK: 'mainnet' }).blockfrost.url).toBe(
      'https://cardano-mainnet.blockfrost.io/api/v0',
    )
  })

  it('honors an explicit BLOCKFROST_URL', () => {
    const config = loadConfig({ BLOCKFROST_URL: 'https://blockfrost.example/api/v0' })
    expect(config.blockfrost.url).toBe('https://blockfrost.example/api/v0')
  })

  it('leaves blockfrost.projectId undefined when PROVIDER is not blockfrost', () => {
    const config = loadConfig({})
    expect(config.blockfrost.projectId).toBeUndefined()
  })

  it('accepts PROVIDER=blockfrost with a project id', () => {
    const config = loadConfig({ PROVIDER: 'blockfrost', BLOCKFROST_PROJECT_ID: 'proj_id' })
    expect(config.provider).toBe('blockfrost')
    expect(config.blockfrost.projectId).toBe('proj_id')
  })

  it('leaves coingeckoApiKey unset by default', () => {
    const config = loadConfig({})
    expect(config.coingeckoApiKey).toBeUndefined()
  })

  it('honors an explicit COINGECKO_API_KEY', () => {
    const config = loadConfig({ COINGECKO_API_KEY: 'my-key' })
    expect(config.coingeckoApiKey).toBe('my-key')
  })

  it('treats an empty COINGECKO_API_KEY as absent', () => {
    const config = loadConfig({ COINGECKO_API_KEY: '' })
    expect(config.coingeckoApiKey).toBeUndefined()
  })

  it('accepts and deduplicates explicit trusted proxy addresses and CIDRs', () => {
    const config = loadConfig({
      TRUST_PROXY: '127.0.0.1, 10.0.0.0/8, 2001:db8::/32, 10.0.0.0/8',
    })
    expect(config.trustedProxies).toEqual(['127.0.0.1', '10.0.0.0/8', '2001:db8::/32'])
  })
})

describe('loadConfig — unhappy path', () => {
  it('rejects an unknown network', () => {
    expect(() => loadConfig({ NETWORK: 'testnet' })).toThrow(ConfigError)
  })

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError)
  })

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(ConfigError)
  })

  it('rejects a malformed KOIOS_URL', () => {
    expect(() => loadConfig({ KOIOS_URL: 'not-a-url' })).toThrow(ConfigError)
  })

  it('rejects a malformed BLOCKFROST_URL', () => {
    expect(() => loadConfig({ BLOCKFROST_URL: 'not-a-url' })).toThrow(ConfigError)
  })

  it.each([
    '*',
    '2',
    'loopback',
    '10.0.0.0/33',
    '2001:db8::/129',
    '10.0.0.1/nope',
    '10.0.0.1/+0',
    '10.0.0.1/-0',
    '10.0.0.1/0x10',
    '10.0.0.1/1e1',
    '10.0.0.1/8.0',
    '10.0.0.1/ 8',
    '10.0.0.1/',
    '10.0.0.1/8/2',
  ])('rejects malformed TRUST_PROXY entry %s', (entry) => {
    expect(() => loadConfig({ TRUST_PROXY: entry })).toThrow(ConfigError)
  })

  it('rejects PROVIDER=blockfrost with no project id', () => {
    expect(() => loadConfig({ PROVIDER: 'blockfrost' })).toThrow(ConfigError)
  })

  it('rejects PROVIDER=blockfrost with an empty project id', () => {
    expect(() => loadConfig({ PROVIDER: 'blockfrost', BLOCKFROST_PROJECT_ID: '' })).toThrow(
      ConfigError,
    )
  })

  it('rejects PROVIDER=blockfrost with a whitespace-only project id', () => {
    expect(() => loadConfig({ PROVIDER: 'blockfrost', BLOCKFROST_PROJECT_ID: '   ' })).toThrow(
      ConfigError,
    )
  })

  it('trims surrounding whitespace from the project id', () => {
    const config = loadConfig({ PROVIDER: 'blockfrost', BLOCKFROST_PROJECT_ID: '  proj_id  ' })
    expect(config.blockfrost.projectId).toBe('proj_id')
  })
})

describe('createProvider', () => {
  it('builds a Koios provider', () => {
    const provider = createProvider(loadConfig({ PROVIDER: 'koios' }))
    expect(provider.name).toBe('koios')
  })

  it('builds a Blockfrost provider', () => {
    const config = loadConfig({ PROVIDER: 'blockfrost', BLOCKFROST_PROJECT_ID: 'proj_id' })
    const provider = createProvider(config)
    expect(provider.name).toBe('blockfrost')
  })

  it('rejects providers that are not wired up yet', () => {
    expect(() => createProvider(loadConfig({ PROVIDER: 'dingo' }))).toThrow(ConfigError)
  })

  it('refuses to build a blockfrost provider from a hand-built config missing a project id', () => {
    // loadConfig itself refuses to produce this shape (see the unhappy-path test above), so
    // this exercises a caller that bypasses the loader and builds an AppConfig directly.
    const config = loadConfig({ PROVIDER: 'koios' })
    const handBuilt = { ...config, provider: 'blockfrost' as const }

    expect(() => createProvider(handBuilt)).toThrow(ConfigError)
  })

  it('refuses to build a blockfrost provider from a hand-built config with a blank project id', () => {
    // Same bypass, but with a whitespace-only project id: a value that clears an undefined check
    // yet is no credential at all. The factory has to normalize it the way loadConfig does.
    const config = loadConfig({ PROVIDER: 'koios' })
    const handBuilt = {
      ...config,
      provider: 'blockfrost' as const,
      blockfrost: { ...config.blockfrost, projectId: '   ' },
    }

    expect(() => createProvider(handBuilt)).toThrow(ConfigError)
  })
})
