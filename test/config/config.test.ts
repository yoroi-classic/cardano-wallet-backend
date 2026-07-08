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
})

describe('createProvider', () => {
  it('builds a Koios provider', () => {
    const provider = createProvider(loadConfig({ PROVIDER: 'koios' }))
    expect(provider.name).toBe('koios')
  })

  it('rejects providers that are not wired up yet', () => {
    expect(() => createProvider(loadConfig({ PROVIDER: 'blockfrost' }))).toThrow(ConfigError)
    expect(() => createProvider(loadConfig({ PROVIDER: 'dingo' }))).toThrow(ConfigError)
  })
})
