/** Node half: the pure-composition bundle's host apply is a no-op carrier. */

import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('session-cost-bundle node half', () => {
  it('applies without throwing', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
