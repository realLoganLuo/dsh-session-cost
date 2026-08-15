/** Node half: the pure-UI plugin's host apply is a no-op carrier. */

import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-session-cost node half', () => {
  it('applies without throwing', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
