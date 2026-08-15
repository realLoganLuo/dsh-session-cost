/**
 * The ledger service: mounting the class beside the real storage hub/domain
 * and a fake sessionQuery corpus serves dashboard rollups from folded logs —
 * incrementally past each session's scan watermark, with pruning for deleted
 * sessions and containment for unreadable logs — and mounts the costStats
 * projection unit on init.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionCostService from '@deepseek-ai/dsh-session-cost'
import type { CostDashboardValue } from '@deepseek-ai/dsh-session-cost/types'

/** Beijing 2026-08-17 10:00 == 02:00Z: inside the official peak window. */
const PEAK_INSTANT = Date.parse('2026-08-17T02:00:00Z')
/** Beijing 2026-08-17 13:00 == 05:00Z: outside the peak windows. */
const OFFPEAK_INSTANT = Date.parse('2026-08-17T05:00:00Z')

/** Build one session log: a step/start + usage-bearing message per request. */
function sessionLog(rows: Array<{
  time: number
  usage: Record<string, number>
  model?: string
  provider?: string
}>): SessionEvent[] {
  const events: SessionEvent[] = []
  let seq = 0
  for (const [index, row] of rows.entries()) {
    const step = index + 1
    events.push({ type: 'step/start', seq: seq++, time: row.time, data: { turn: 1, step } } as unknown as SessionEvent)
    events.push({
      type: 'assistant/message',
      seq: seq++,
      time: row.time + 60_000,
      data: {
        turn: 1,
        step,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          source: {
            kind: 'model',
            provider: row.provider ?? 'deepseek-official',
            model: row.model ?? 'deepseek-v4-flash',
          },
        }),
        usage: row.usage,
      },
    } as unknown as SessionEvent)
  }
  return events
}

/** Stateful fake of the sessionQuery face: logs and sessions mutate across calls. */
class FakeQuery {
  logs = new Map<string, SessionEvent[]>()
  sessions: Array<{ id: SessionId; cwd?: string; createdAt?: number }> = []
  listCalls = 0
  failSession: string | null = null

  listSessions(): Promise<readonly { header: { id: SessionId; cwd?: string } }[]> {
    this.listCalls += 1
    if (this.failSession === 'list') return Promise.reject(new Error('corpus down'))
    return Promise.resolve(this.sessions.map(session => ({ header: session })))
  }

  readSession(id: SessionId): Promise<{ events: readonly SessionEvent[] }> {
    if (this.failSession === String(id)) return Promise.reject(new Error('boom'))
    return Promise.resolve({ events: this.logs.get(String(id)) ?? [] })
  }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-cost-test-'))
  const ctx = new Context()
  const query = new FakeQuery()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    ctx.provide('sessionQuery', query as never)
    const fiber = await ctx.plugin(SessionCostService)
    return { ctx, query, fiber, root }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function dashboard(ctx: Context, request: Parameters<SessionCostService['dashboard']>[0] = {}): Promise<CostDashboardValue> {
  const service = ctx.get('cost') as SessionCostService
  return service.dashboard(request)
}

describe('SessionCostService', () => {
  it('mounts the costStats projection unit on init', async () => {
    const h = await harness()
    try {
      const session = h.ctx.sessions.create(SessionId('live'))
      const values = h.ctx.sessionProjections.snapshot(session).values
      expect('costStats' in values).toBe(true)
      expect(values.costStats).toEqual({
        pricedRequests: 0, unpricedRequests: 0, totalCost: 0, models: {}, days: {}, versions: {},
      })
    } finally {
      await h.fiber.dispose()
      await rm(h.root, { recursive: true, force: true })
    }
  })

  it('serves dashboard rollups over the folded corpus', async () => {
    const h = await harness()
    try {
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a', createdAt: 1 },
        { id: SessionId('b'), cwd: '/proj-b', createdAt: 2 },
        { id: SessionId('d'), createdAt: 3 },
      ]
      h.query.logs.set('d', sessionLog([
        { time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
      ]))
      h.query.logs.set('a', sessionLog([
        // Peak flash: 1M miss * 3 + 0.5M hit * 0.1 + 0.2M out * 9 = 4.85
        { time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 500_000 } },
      ]))
      h.query.logs.set('b', sessionLog([
        // Off-peak pro: 1M miss * 4.5 + 0.1M out * 13.5 = 5.85
        { time: OFFPEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 100_000 }, model: 'deepseek-v4-pro' },
        // Unpriced model
        { time: OFFPEAK_INSTANT, usage: { inputTokens: 100_000, outputTokens: 0 }, model: 'claude-sonnet', provider: 'anthropic' },
      ]))
      const value = await dashboard(h.ctx)
      expect(value.pricedRequests).toBe(3)
      expect(value.unpricedRequests).toBe(1)
      expect(value.totalCost).toBeCloseTo(4.85 + 5.85 + 3, 10)
      // Models bucket priced requests only; the unpriced request counts separately.
      expect(Object.keys(value.models).sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
      expect(value.models['deepseek-v4-flash']?.cost).toBeCloseTo(4.85 + 3, 10)
      expect(value.groups['2026-08-17']?.requests).toBe(4)
      expect(Object.keys(value.versions)).toEqual(['deepseek-2026-08-17'])
      expect(value.projects).toEqual(['', '/proj-a', '/proj-b'])
    } finally {
      await h.fiber.dispose()
      await rm(h.root, { recursive: true, force: true })
    }
  })

  it('filters by project and groups by model', async () => {
    const h = await harness()
    try {
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a' },
        { id: SessionId('b'), cwd: '/proj-b' },
      ]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.logs.set('b', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 }, model: 'deepseek-v4-pro' }]))
      const filtered = await dashboard(h.ctx, { project: '/proj-a' })
      expect(filtered.pricedRequests).toBe(1)
      expect(filtered.totalCost).toBeCloseTo(3, 10)
      const byModel = await dashboard(h.ctx, { groupBy: 'model' })
      expect(byModel.groups['deepseek-v4-flash']?.requests).toBe(1)
      expect(byModel.groups['deepseek-v4-pro']?.requests).toBe(1)
      const byWeek = await dashboard(h.ctx, { groupBy: 'week' })
      expect(Object.keys(byWeek.groups)).toEqual(['2026-08-17'])
    } finally {
      await h.fiber.dispose()
      await rm(h.root, { recursive: true, force: true })
    }
  })

  it('reconciles incrementally past the scan watermark after the interval', async () => {
    vi.useFakeTimers()
    try {
      const h = await harness()
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      const first = await dashboard(h.ctx)
      expect(first.totalCost).toBeCloseTo(3, 10)
      const scansBefore = h.query.listCalls
      // Throttled: an immediate second call does not rescan.
      const second = await dashboard(h.ctx)
      expect(h.query.listCalls).toBe(scansBefore)
      expect(second.totalCost).toBeCloseTo(3, 10)
      // After the interval, a grown log folds only the new request.
      h.query.logs.set('a', sessionLog([
        { time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
        { time: OFFPEAK_INSTANT, usage: { inputTokens: 500_000, outputTokens: 0 } },
      ]))
      vi.setSystemTime(Date.now() + 6_000)
      const third = await dashboard(h.ctx)
      expect(third.totalCost).toBeCloseTo(3 + 0.75, 10)
      expect(third.pricedRequests).toBe(2)
      // A repeated scan after the interval adds nothing.
      vi.setSystemTime(Date.now() + 6_000)
      const fourth = await dashboard(h.ctx)
      expect(fourth.totalCost).toBeCloseTo(3.75, 10)
      await h.fiber.dispose()
      await rm(h.root, { recursive: true, force: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes rows of deleted sessions', async () => {
    vi.useFakeTimers()
    try {
      const h = await harness()
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a' },
        { id: SessionId('b'), cwd: '/proj-b' },
      ]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.logs.set('b', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 2_000_000, outputTokens: 0 } }]))
      const before = await dashboard(h.ctx)
      expect(before.pricedRequests).toBe(2)
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      vi.setSystemTime(Date.now() + 6_000)
      const after = await dashboard(h.ctx)
      expect(after.pricedRequests).toBe(1)
      expect(after.totalCost).toBeCloseTo(3, 10)
      await h.fiber.dispose()
      await rm(h.root, { recursive: true, force: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips malformed usage and mismatched steps in the ledger fold', async () => {
    const h = await harness()
    try {
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', [
        { type: 'step/start', seq: 0, time: PEAK_INSTANT, data: { turn: 1, step: 1 } } as unknown as SessionEvent,
        { type: 'assistant/message', seq: 1, time: PEAK_INSTANT + 1, data: { turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } } as unknown as SessionEvent,
        { type: 'turn/start', seq: 2, time: PEAK_INSTANT + 2, data: { turn: 2 } } as unknown as SessionEvent,
        { type: 'assistant/message', seq: 3, time: PEAK_INSTANT + 3, data: { turn: 2, step: 1, message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } }), usage: { inputTokens: 1_000_000, outputTokens: 0 } } } as unknown as SessionEvent,
      ])
      const value = await dashboard(h.ctx)
      // Malformed (no usage) skipped; the mismatched message bills at its own time.
      expect(value.pricedRequests).toBe(1)
      expect(value.totalCost).toBeCloseTo(3, 10)
    } finally {
      await h.fiber.dispose()
      await rm(h.root, { recursive: true, force: true })
    }
  })

  it('groups by month and project', async () => {
    const h = await harness()
    try {
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a' },
        { id: SessionId('b'), cwd: '/proj-b' },
      ]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.logs.set('b', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 }, model: 'deepseek-v4-pro' }]))
      const byMonth = await dashboard(h.ctx, { groupBy: 'month' })
      expect(byMonth.groups['2026-08']?.requests).toBe(2)
      const byProject = await dashboard(h.ctx, { groupBy: 'project' })
      expect(byProject.groups['/proj-a']?.requests).toBe(1)
      expect(byProject.groups['/proj-b']?.requests).toBe(1)
    } finally {
      await h.fiber.dispose()
      await rm(h.root, { recursive: true, force: true })
    }
  })

  it('filters by billing instant bounds', async () => {
    const h = await harness()
    try {
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', sessionLog([
        { time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
        { time: OFFPEAK_INSTANT, usage: { inputTokens: 500_000, outputTokens: 0 } },
      ]))
      // A lower bound after the first request's billing instant excludes it.
      const afterFirst = await dashboard(h.ctx, { from: PEAK_INSTANT + 1, to: OFFPEAK_INSTANT + 1 })
      expect(afterFirst.pricedRequests).toBe(1)
      expect(afterFirst.totalCost).toBeCloseTo(0.75, 10)
      // An upper bound equal to the earlier billing instant excludes both.
      const bounded = await dashboard(h.ctx, { to: PEAK_INSTANT })
      expect(bounded.pricedRequests).toBe(0)
    } finally {
      await h.fiber.dispose()
      await rm(h.root, { recursive: true, force: true })
    }
  })

  it('shares one in-flight reconcile between concurrent calls', async () => {
    const h = await harness()
    try {
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      const [first, second] = await Promise.all([dashboard(h.ctx), dashboard(h.ctx)])
      expect(first.totalCost).toBeCloseTo(3, 10)
      expect(second.totalCost).toBeCloseTo(3, 10)
      expect(h.query.listCalls).toBe(1)
    } finally {
      await h.fiber.dispose()
      await rm(h.root, { recursive: true, force: true })
    }
  })

  it('fails loud on a broken corpus and retries after the interval', async () => {
    vi.useFakeTimers()
    try {
      const h = await harness()
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.failSession = 'list'
      await expect(dashboard(h.ctx)).rejects.toThrow()
      h.query.failSession = null
      vi.setSystemTime(Date.now() + 6_000)
      const value = await dashboard(h.ctx)
      expect(value.pricedRequests).toBe(1)
      await h.fiber.dispose()
      await rm(h.root, { recursive: true, force: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the ledger when a session id is reused by a fresh lifecycle', async () => {
    vi.useFakeTimers()
    try {
      const h = await harness()
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a', createdAt: 1 },
        { id: SessionId('b'), cwd: '/proj-b', createdAt: 1 },
      ]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.logs.set('b', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 500_000, outputTokens: 0 } }]))
      const first = await dashboard(h.ctx)
      expect(first.pricedRequests).toBe(2)
      // The id is reused by a new lifecycle: the old rows are dropped and the
      // fresh log folds from scratch.
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a', createdAt: 2 },
        { id: SessionId('b'), cwd: '/proj-b', createdAt: 1 },
      ]
      h.query.logs.set('a', sessionLog([
        { time: PEAK_INSTANT, usage: { inputTokens: 2_000_000, outputTokens: 0 } },
      ]))
      vi.setSystemTime(Date.now() + 6_000)
      const second = await dashboard(h.ctx)
      // a refolded from scratch; b's rows untouched.
      expect(second.pricedRequests).toBe(2)
      expect(second.models['deepseek-v4-flash']?.requests).toBe(2)
      expect(second.totalCost).toBeCloseTo(6 + 1.5, 10)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bills a message arriving after the scan watermark at its step start', async () => {
    vi.useFakeTimers()
    try {
      const h = await harness()
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a', createdAt: 1 }]
      // Batch 1 ends mid-step: only the step/start is folded.
      h.query.logs.set('a', [
        { type: 'step/start', seq: 0, time: PEAK_INSTANT, data: { turn: 1, step: 1 } } as unknown as SessionEvent,
      ])
      await dashboard(h.ctx)
      // Batch 2 carries the message for that step. The message lands at
      // 05:00Z (Beijing 13:00, off-peak); the step started at 02:00Z (peak).
      // Billing must follow the step start: peak Flash miss rate 3, not the
      // message-time standard rate 1.5.
      h.query.logs.set('a', [
        { type: 'step/start', seq: 0, time: PEAK_INSTANT, data: { turn: 1, step: 1 } } as unknown as SessionEvent,
        { type: 'assistant/message', seq: 1, time: OFFPEAK_INSTANT, data: { turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } }), usage: { inputTokens: 1_000_000, outputTokens: 0 } } } as unknown as SessionEvent,
      ])
      vi.setSystemTime(Date.now() + 6_000)
      const value = await dashboard(h.ctx)
      expect(value.pricedRequests).toBe(1)
      expect(value.totalCost).toBeCloseTo(3, 10)
    } finally {
      vi.useRealTimers()
    }
  })

  it('contains unreadable sessions without failing the pass', async () => {
    const h = await harness()
    try {
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a' },
        { id: SessionId('bad'), cwd: '/proj-b' },
      ]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.logs.set('bad', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.failSession = 'bad'
      const value = await dashboard(h.ctx)
      expect(value.pricedRequests).toBe(1)
      expect(value.totalCost).toBeCloseTo(3, 10)
    } finally {
      await h.fiber.dispose()
      await rm(h.root, { recursive: true, force: true })
    }
  })
})
