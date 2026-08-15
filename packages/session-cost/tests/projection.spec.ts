/**
 * The `costStats` projection unit: mounting the plugin beside the projection
 * registry prices every usage-bearing assistant message from its model,
 * billing instant, and the official rate-card version, and serves
 * whole-session model/day/version buckets; compositions without the registry
 * are unaffected; unmounting the plugin removes the key (HMR safety).
 * Controlled-time folds run against the exported definition directly, where
 * the exact tariff math (peak/off-peak, version boundary, billing instant
 * choice) is pinned.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { sessionCostProjectionDefinition } from '@logan-luo/dsh-session-cost/src/projection.ts'
import type { SessionCostProjection } from '@logan-luo/dsh-session-cost/types'

async function harness(withUnit: boolean): Promise<{
  ctx: Context
  session: Session
  dispose: () => void
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const dispose = withUnit
    ? ctx.sessionProjections.register(sessionCostProjectionDefinition)
    : () => {}
  return { ctx, session: ctx.sessions.create(SessionId('costed')), dispose }
}

/** Append one usage-bearing model request (registry drive; time is host-assigned). */
function appendPricedRequest(
  session: Session,
  turn: number,
  step: number,
  overrides: { provider?: string; model?: string } = {},
): void {
  session.append('step/start', { turn, step })
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'model', provider: overrides.provider ?? 'deepseek-official', model: overrides.model ?? 'deepseek-v4-flash' },
    }),
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cacheReadTokens: 500_000,
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
}

function viewOf(ctx: Context, session: Session): SessionCostProjection {
  const value = ctx.sessionProjections.snapshot(session).values.costStats
  if (value === undefined) throw new Error('costStats projection missing')
  return value
}

describe('costStats projection unit (registry drive)', () => {
  it('serves zero figures on the empty log', async () => {
    const { ctx, session } = await harness(true)
    expect(viewOf(ctx, session)).toEqual({
      pricedRequests: 0, unpricedRequests: 0, totalCost: 0, models: {}, days: {}, versions: {},
    })
  })

  it('prices one request into model, day, and version buckets', async () => {
    const { ctx, session } = await harness(true)
    appendPricedRequest(session, 1, 1)
    const view = viewOf(ctx, session)
    expect(view.pricedRequests).toBe(1)
    expect(view.unpricedRequests).toBe(0)
    expect(view.totalCost).toBeGreaterThan(0)
    const flash = view.models['deepseek-v4-flash']
    expect(flash).toBeDefined()
    expect(flash).toEqual({
      requests: 1, cost: view.totalCost, inputMissTokens: 1_000_000, inputHitTokens: 500_000, outputTokens: 200_000,
    })
    expect(Object.keys(view.days)).toHaveLength(1)
    expect(Object.values(view.days)[0]).toEqual({ requests: 1, cost: view.totalCost })
    expect(Object.keys(view.versions)).toHaveLength(1)
    expect(Object.values(view.versions)[0]).toBe(1)
  })

  it('accumulates separate model buckets across requests', async () => {
    const { ctx, session } = await harness(true)
    appendPricedRequest(session, 1, 1, { model: 'deepseek-v4-flash' })
    appendPricedRequest(session, 1, 2, { model: 'deepseek-v4-pro' })
    const view = viewOf(ctx, session)
    expect(view.pricedRequests).toBe(2)
    expect(Object.keys(view.models).sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  })

  it('counts non-official providers and unknown models as unpriced', async () => {
    const { ctx, session } = await harness(true)
    appendPricedRequest(session, 1, 1, { provider: 'anthropic', model: 'claude-sonnet' })
    appendPricedRequest(session, 1, 2, { provider: 'deepseek-official', model: 'deepseek-v3' })
    const view = viewOf(ctx, session)
    expect(view.pricedRequests).toBe(0)
    expect(view.unpricedRequests).toBe(2)
    expect(view.totalCost).toBe(0)
  })

  it('ignores messages without usage', async () => {
    const { ctx, session } = await harness(true)
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    const view = viewOf(ctx, session)
    expect(view.pricedRequests).toBe(0)
    expect(view.unpricedRequests).toBe(0)
  })

  it('bills every usage-bearing message of one step (retries) once each', async () => {
    const { ctx, session } = await harness(true)
    session.append('step/start', { turn: 1, step: 1 })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      session.append('assistant/message', {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        }),
        usage: { inputTokens: 100_000, outputTokens: 0 },
      }, { surfaceOp: 'append', sourceEventSeqs: [] })
    }
    const view = viewOf(ctx, session)
    expect(view.pricedRequests).toBe(2)
    expect(view.models['deepseek-v4-flash']?.requests).toBe(2)
  })

  it('has no costStats key without the unit, and drops it when the registration is disposed (HMR safety)', async () => {
    const { ctx, session, dispose } = await harness(false)
    expect('costStats' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const register = ctx.sessionProjections.register(sessionCostProjectionDefinition)
    appendPricedRequest(session, 1, 1)
    expect(viewOf(ctx, session).pricedRequests).toBe(1)
    register()
    expect('costStats' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    dispose()
  })
})

/** Build one synthetic committed event with a controlled timestamp. */
function at(time: number, type: string, data: unknown): SessionEvent {
  return { type, seq: time, time, data } as unknown as SessionEvent
}

/** Fold a synthetic event list through the definition and view the result. */
function fold(events: readonly SessionEvent[]): SessionCostProjection {
  const state = events.reduce(
    (folded, event) => sessionCostProjectionDefinition.apply(folded, event),
    sessionCostProjectionDefinition.init(),
  )
  return sessionCostProjectionDefinition.view(state)
}

/** Beijing 2026-08-17 10:00 == 02:00Z: inside the official peak window. */
const PEAK_INSTANT = Date.parse('2026-08-17T02:00:00Z')
/** Beijing 2026-08-17 13:00 == 05:00Z: outside the peak windows. */
const OFFPEAK_INSTANT = Date.parse('2026-08-17T05:00:00Z')
/** Before the 2026-08-17 rate-version boundary. */
const PRE_BOUNDARY_INSTANT = Date.parse('2026-08-16T15:00:00Z')

function pricedMessage(usage: Record<string, number>): unknown {
  return {
    turn: 1, step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage,
  }
}


describe('costStats fold (controlled times)', () => {
  it('prices peak requests at the peak card', () => {
    const view = fold([
      at(PEAK_INSTANT, 'step/start', { turn: 1, step: 1 }),
      at(PEAK_INSTANT + 60_000, 'assistant/message', pricedMessage({ inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 500_000 })),
    ])
    // Peak Flash card: 1M * 3 + 0.5M * 0.1 + 0.2M * 9 = 4.85
    expect(view.totalCost).toBeCloseTo(4.85, 10)
    expect(view.versions['deepseek-2026-08-17']).toBe(1)
    const day = view.days['2026-08-17']
    expect(day).toEqual({ requests: 1, cost: 4.85 })
  })

  it('prices off-peak requests at the standard card', () => {
    const view = fold([
      at(OFFPEAK_INSTANT, 'step/start', { turn: 1, step: 1 }),
      at(OFFPEAK_INSTANT + 60_000, 'assistant/message', pricedMessage({ inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 500_000 })),
    ])
    // Standard Flash card: 1M * 1.5 + 0.5M * 0.05 + 0.2M * 4.5 = 2.425
    expect(view.totalCost).toBeCloseTo(2.425, 10)
  })

  it('prices pre-boundary requests at the earlier rate version and day', () => {
    const view = fold([
      at(PRE_BOUNDARY_INSTANT, 'step/start', { turn: 1, step: 1 }),
      at(PRE_BOUNDARY_INSTANT + 60_000, 'assistant/message', pricedMessage({ inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 500_000 })),
    ])
    // Pre-boundary Flash card: 1M * 1 + 0.5M * 0.02 + 0.2M * 2 = 1.41
    expect(view.totalCost).toBeCloseTo(1.41, 10)
    expect(view.versions['deepseek-pre-2026-08-17']).toBe(1)
    expect(view.days['2026-08-16']?.requests).toBe(1)
    expect(view.days['2026-08-16']?.cost).toBeCloseTo(1.41, 10)
  })

  it('selects peak pricing from the step start, not the message time', () => {
    // Step starts 05:00Z (Beijing 13:00, off-peak); the message lands 06:30Z
    // (Beijing 14:30, peak), after the step start. Request start decides the
    // tariff period, so the request bills off-peak.
    const view = fold([
      at(OFFPEAK_INSTANT, 'step/start', { turn: 1, step: 1 }),
      at(Date.parse('2026-08-17T06:30:00Z'), 'assistant/message', pricedMessage({ inputTokens: 1_000_000, outputTokens: 0 })),
    ])
    expect(view.totalCost).toBeCloseTo(1.5, 10)
    const day = view.days['2026-08-17']
    expect(day).toEqual({ requests: 1, cost: 1.5 })
  })

  it('falls back to the message time when the step does not match the open step', () => {
    // The open step is turn 2; the message belongs to turn 1 (restored or
    // interleaved history): no step match, so the peak message time bills peak.
    const view = fold([
      at(OFFPEAK_INSTANT, 'step/start', { turn: 2, step: 1 }),
      at(PEAK_INSTANT, 'assistant/message', pricedMessage({ inputTokens: 1_000_000, outputTokens: 0 })),
    ])
    expect(view.totalCost).toBeCloseTo(3, 10)
  })

  it('drops malformed usage without counting priced or unpriced', () => {
    const view = fold([
      at(PEAK_INSTANT, 'step/start', { turn: 1, step: 1 }),
      at(PEAK_INSTANT + 60_000, 'assistant/message', pricedMessage({})),
      at(PEAK_INSTANT + 120_000, 'assistant/message', pricedMessage({ inputTokens: -1, outputTokens: 0 })),
      at(PEAK_INSTANT + 180_000, 'assistant/message', pricedMessage({ inputTokens: 0, outputTokens: Number.NaN })),
    ])
    expect(view.pricedRequests).toBe(0)
    expect(view.unpricedRequests).toBe(0)
  })

  it('returns the same state reference for an identical step/start re-emission', () => {
    const first = sessionCostProjectionDefinition.apply(
      sessionCostProjectionDefinition.init(),
      at(PEAK_INSTANT, 'step/start', { turn: 1, step: 1 }),
    )
    const second = sessionCostProjectionDefinition.apply(
      first,
      at(PEAK_INSTANT, 'step/start', { turn: 1, step: 1 }),
    )
    expect(second).toBe(first)
  })

  it('updates the billing instant when a step re-emits with a later start', () => {
    const first = sessionCostProjectionDefinition.apply(
      sessionCostProjectionDefinition.init(),
      at(OFFPEAK_INSTANT, 'step/start', { turn: 1, step: 1 }),
    )
    const second = sessionCostProjectionDefinition.apply(
      first,
      at(PEAK_INSTANT, 'step/start', { turn: 1, step: 1 }),
    )
    expect(second).not.toBe(first)
    const view = sessionCostProjectionDefinition.view(sessionCostProjectionDefinition.apply(
      second,
      at(PEAK_INSTANT + 60_000, 'assistant/message', pricedMessage({ inputTokens: 1_000_000, outputTokens: 0 })),
    ))
    // The re-emitted step start (peak) decides the tariff, not the original.
    expect(view.totalCost).toBeCloseTo(3, 10)
  })

  it('ignores unrelated events', () => {
    const view = fold([
      at(PEAK_INSTANT, 'turn/start', { turn: 1 }),
      at(PEAK_INSTANT + 1, 'user/message', { turn: 1 }),
      at(PEAK_INSTANT + 2, 'todo/write', { todos: [] }),
    ])
    expect(view.pricedRequests).toBe(0)
    expect(view.unpricedRequests).toBe(0)
  })

  it('prices with the cache-write bucket present and excluded from billing', () => {
    const view = fold([
      at(PEAK_INSTANT, 'step/start', { turn: 1, step: 1 }),
      at(PEAK_INSTANT + 60_000, 'assistant/message', pricedMessage({
        inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 9_000_000,
      })),
    ])
    expect(view.totalCost).toBeCloseTo(3, 10)
  })

  it('uses the message time when no open step matches', () => {
    const view = fold([
      at(PEAK_INSTANT, 'assistant/message', pricedMessage({ inputTokens: 1_000_000, outputTokens: 0 })),
    ])
    expect(view.totalCost).toBeCloseTo(3, 10)
  })
})
