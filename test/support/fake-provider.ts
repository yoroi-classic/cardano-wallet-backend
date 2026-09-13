import type { ChainProvider } from '../../src/providers/provider.js'

/**
 * A ChainProvider whose methods throw unless the test stubs them.
 *
 * Built on a Proxy rather than an object literal so that adding a capability to
 * ChainProvider never forces an edit here, nor in the tests that don't exercise it. That
 * is the point: the old hand-written fake listed every method, so one new provider method
 * meant touching every HTTP test, and concurrent branches all collided on those files.
 *
 * Stub only what the behavior under test actually calls. Anything else throws, so an
 * unexpected provider call fails loudly instead of quietly returning undefined.
 */
export function fakeProvider(overrides: Partial<ChainProvider> = {}): ChainProvider {
  const stubs: Partial<ChainProvider> = { name: 'fake', ...overrides }

  return new Proxy(stubs as ChainProvider, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)

      // `then` has to stay absent. A Proxy that answers it looks thenable, so awaiting
      // anything holding this provider would try to call it as a callback.
      if (prop === 'then' || typeof prop === 'symbol') return undefined

      return () => {
        throw new Error(`fake provider: ${prop}() was called but the test did not stub it`)
      }
    },
  })
}
