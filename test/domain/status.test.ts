import { describe, expect, it } from 'vitest'
import { asServerTime } from '../../src/domain/types/status.js'

describe('server status time', () => {
  it('preserves an exact Unix millisecond integer', () => {
    expect(asServerTime(1_784_674_800_123)).toBe(1_784_674_800_123)
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a value JSON clients cannot preserve exactly: %s',
    (value) => {
      expect(() => asServerTime(value)).toThrow('server time must be a non-negative safe integer')
    },
  )
})
