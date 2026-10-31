import type { PriceProvider } from '../../src/prices/index.js'

/**
 * A PriceProvider whose methods throw unless the test stubs them. Same shape as
 * `fakeProvider` (see fake-provider.ts) and for the same reason: stub only what the
 * behavior under test actually calls, so an unexpected call fails loudly.
 */
export function fakePriceProvider(overrides: Partial<PriceProvider> = {}): PriceProvider {
  const stubs: Partial<PriceProvider> = { ...overrides }

  return new Proxy(stubs as PriceProvider, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)

      // `then` has to stay absent, or a Proxy holding this provider looks thenable and
      // awaiting it tries to call it as a callback.
      if (prop === 'then' || typeof prop === 'symbol') return undefined

      return () => {
        throw new Error(`fake price provider: ${prop}() was called but the test did not stub it`)
      }
    },
  })
}
