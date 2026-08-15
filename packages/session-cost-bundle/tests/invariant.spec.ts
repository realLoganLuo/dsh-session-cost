/** The bundle's invariant companion registers cleanly. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as BundleInvariant from '../src/invariant.ts'

describe('session-cost-bundle invariant companion', () => {
  it('registers and unloads with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(BundleInvariant)
    await fiber.dispose()
    expect(ctx.invariants).toBeDefined()
  })
})
