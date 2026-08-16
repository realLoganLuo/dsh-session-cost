/**
 * The ledger service: mounting the class beside the real storage hub/domain,
 * the timer plugin, and a fake sessionQuery corpus serves dashboard rollups
 * from folded logs. Reconciliation runs in the background — a warm-up pass at
 * init, then one pass per `reconcileIntervalMs` tick — so dashboard reads are
 * pure rollups over the last successfully reconciled ledger.
 */

import { describe, expect, it, vi } from 'vitest'

// Background passes depend on real disk I/O (storage-json fsyncs), which can
// occasionally stall for seconds; keep vitest from abandoning a slow test and
// corrupting the fake-timer state of the ones after it.
vi.setConfig({ testTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionCostService, { type SessionCostConfig } from '@logan-luo/dsh-session-cost'
import type { CostDashboardValue, CostRow } from '@logan-luo/dsh-session-cost/types'

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
  /** 'list' fails listSessions; a session id fails readSession for that session. */
  failSession: string | null = null
  /** When set, listSessions waits for this promise before responding (pass gating). */
  gate: Promise<void> | null = null
  /** Concurrent-pass watermark: reconciliation must never overlap passes. */
  maxActiveScans = 0
  private activeScans = 0

  listSessions(): Promise<readonly { header: { id: SessionId; cwd?: string; createdAt?: number } }[]> {
    this.listCalls += 1
    this.activeScans += 1
    this.maxActiveScans = Math.max(this.maxActiveScans, this.activeScans)
    const respond = (): readonly { header: { id: SessionId; cwd?: string; createdAt?: number } }[] =>
      this.sessions.map(session => ({ header: session }))
    const result = this.gate !== null
      ? this.gate.then(respond)
      : this.failSession === 'list'
        ? Promise.reject(new Error('corpus down'))
        : Promise.resolve(respond())
    return result.finally(() => { this.activeScans -= 1 })
  }

  readSession(id: SessionId): Promise<{ events: readonly SessionEvent[] }> {
    if (this.failSession === String(id)) return Promise.reject(new Error('boom'))
    return Promise.resolve({ events: this.logs.get(String(id)) ?? [] })
  }
}

interface Harness {
  ctx: Context
  query: FakeQuery
  fiber: { dispose(): Promise<void> }
  root: string
}

async function harness(
  config?: Partial<SessionCostConfig>,
  rootDir?: string,
  seed?: (query: FakeQuery) => void,
): Promise<Harness> {
  const root = rootDir ?? await mkdtemp(join(tmpdir(), 'dsh-session-cost-test-'))
  const ctx = new Context()
  const query = new FakeQuery()
  // Seed the corpus before the service mounts so the init warm-up sees it.
  seed?.(query)
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(Timer)
    ctx.provide('sessionQuery', query as never)
    const fiber = await ctx.plugin(SessionCostService, config)
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

/** The real timer captured before any test installs fake timers: used to let
 * real disk I/O (storage-json fsyncs) complete while the fake clock is frozen. */
const realSetTimeout = globalThis.setTimeout

/** Sleep for real wall-clock time; fake timers never see this. */
async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => { realSetTimeout(resolve, ms) })
}

/** Wait long enough for an already-started pass's storage I/O to settle. */
async function settle(ms = 25): Promise<void> {
  await sleep(ms)
}

/** Wait until `listSessions` has been called at least `count` times. */
async function untilScans(query: FakeQuery, count: number): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (query.listCalls >= count) {
      await settle()
      return
    }
    await sleep(10)
  }
  throw new Error(`expected >= ${count} listSessions calls, saw ${query.listCalls}`)
}

/**
 * Fire the background ticks: six reconcile periods. The dashboard shows rows
 * as soon as the row write lands, but a pass's tail (watermark write, prune
 * loops) still runs for a few real milliseconds; later ticks that merge into
 * it are skipped, so advancing several periods guarantees at least one tick
 * lands on a fresh pass over the current corpus.
 */
async function advanceTicks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(30_000)
}

/**
 * Poll the dashboard until `assert` passes, then give the pass that wrote the
 * rows real time to finish its tail (watermark write, prune loops). Without
 * this, a following `advanceTicks` could see the dying pass still in flight
 * and skip every tick, leaving the next corpus unreconciled.
 */
async function untilDashboard(h: Harness, assert: (value: CostDashboardValue) => void): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    try {
      assert(await dashboard(h.ctx))
      await settle(50)
      return
    } catch {
      await sleep(10)
    }
  }
  assert(await dashboard(h.ctx))
}

describe('SessionCostService', () => {
  it('serves the durable ledger immediately on restart', async () => {
    vi.useFakeTimers()
    let h1: Harness | undefined
    let h2: Harness | undefined
    try {
      h1 = await harness()
      h1.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a', createdAt: 1 }]
      h1.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      await advanceTicks()
      await untilDashboard(h1, value => { expect(value.pricedRequests).toBe(1) })
      const root = h1.root
      await h1.fiber.dispose()
      h1 = undefined
      // Reopen the same storage root: the durable rows are served from the
      // snapshot immediately, before any background pass could complete.
      h2 = await harness(undefined, root)
      const value = await dashboard(h2.ctx)
      expect(value.pricedRequests).toBe(1)
      expect(value.totalCost).toBeCloseTo(3, 10)
      await h2.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      h2 = undefined
    } finally {
      await h1?.fiber.dispose()
      if (h1 !== undefined) await rm(h1.root, { recursive: true, force: true })
      await h2?.fiber.dispose()
      if (h2 !== undefined) await rm(h2.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('hides durable rows not covered by a watermark after a reload', async () => {
    vi.useFakeTimers()
    let h1: Harness | undefined
    let h2: Harness | undefined
    try {
      h1 = await harness()
      h1.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a', createdAt: 1 }]
      h1.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      await advanceTicks()
      await untilDashboard(h1, value => { expect(value.pricedRequests).toBe(1) })
      const root = h1.root
      await h1.fiber.dispose()
      h1 = undefined
      // Simulate a pass that failed mid-write: two rows persist without a
      // covering watermark — one past the session's lastSeq, one for a
      // session whose meta write never happened.
      const unitPath = join(root, 'session_cost.json')
      const unit = JSON.parse(await readFile(unitPath, 'utf8')) as {
        tables: { rows: Record<string, CostRow> }
      }
      unit.tables.rows['a\u00002'] = {
        sessionId: 'a', seq: 2, project: '/proj-a', model: 'deepseek-v4-flash', provider: 'deepseek-official',
        billedAt: PEAK_INSTANT, missTokens: 1_000_000, hitTokens: 0, outputTokens: 0, cost: 3, versionId: null,
      }
      unit.tables.rows['orphan\u00000'] = {
        sessionId: 'orphan', seq: 0, project: '/proj-x', model: 'deepseek-v4-flash', provider: 'deepseek-official',
        billedAt: PEAK_INSTANT, missTokens: 1_000_000, hitTokens: 0, outputTokens: 0, cost: 3, versionId: null,
      }
      await writeFile(unitPath, `${JSON.stringify(unit, null, 2)}\n`)
      // The reloaded snapshot serves only the committed row.
      h2 = await harness(undefined, root)
      const value = await dashboard(h2.ctx)
      expect(value.pricedRequests).toBe(1)
      expect(value.models['deepseek-v4-flash']?.requests).toBe(1)
      expect(value.projects).toEqual(['/proj-a'])
      await h2.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      h2 = undefined
    } finally {
      await h1?.fiber.dispose()
      if (h1 !== undefined) await rm(h1.root, { recursive: true, force: true })
      await h2?.fiber.dispose()
      if (h2 !== undefined) await rm(h2.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('never republishes uncovered rows after a pass that skipped an unreadable session', async () => {
    vi.useFakeTimers()
    let h1: Harness | undefined
    let h2: Harness | undefined
    try {
      h1 = await harness()
      h1.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a', createdAt: 1 }]
      h1.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      await advanceTicks()
      await untilDashboard(h1, value => { expect(value.pricedRequests).toBe(1) })
      const root = h1.root
      await h1.fiber.dispose()
      h1 = undefined
      // An earlier failed pass left one row whose meta write never happened
      // (seq 2 > the committed watermark's lastSeq 1).
      const unitPath = join(root, 'session_cost.json')
      const unit = JSON.parse(await readFile(unitPath, 'utf8')) as {
        tables: { rows: Record<string, CostRow> }
      }
      unit.tables.rows['a\u00002'] = {
        sessionId: 'a', seq: 2, project: '/proj-a', model: 'deepseek-v4-flash', provider: 'deepseek-official',
        billedAt: PEAK_INSTANT, missTokens: 1_000_000, hitTokens: 0, outputTokens: 0, cost: 3, versionId: null,
      }
      await writeFile(unitPath, `${JSON.stringify(unit, null, 2)}\n`)
      // The next pass skips the unreadable session (contained failure) and
      // completes "successfully"; it must not publish the uncovered row. The
      // corpus is seeded before init so the warm-up sees the session and does
      // not prune the persisted rows.
      h2 = await harness(undefined, root, query => {
        query.sessions = [{ id: SessionId('a'), cwd: '/proj-a', createdAt: 1 }]
        query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
        query.failSession = 'a'
      })
      await advanceTicks()
      await untilScans(h2.query, 2)
      await untilDashboard(h2, value => {
        expect(value.pricedRequests).toBe(1)
        expect(value.totalCost).toBeCloseTo(3, 10)
      })
      await h2.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      h2 = undefined
    } finally {
      await h1?.fiber.dispose()
      if (h1 !== undefined) await rm(h1.root, { recursive: true, force: true })
      await h2?.fiber.dispose()
      if (h2 !== undefined) await rm(h2.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

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

  it('reconciles at startup without any dashboard call, then on background ticks', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      // The init warm-up pass starts without any dashboard involvement.
      await untilScans(h.query, 1)
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
      // The tick after the interval folds the corpus without a dashboard call.
      const scansBefore = h.query.listCalls
      await advanceTicks()
      await untilScans(h.query, scansBefore + 1)
      await untilDashboard(h, value => {
        expect(value.pricedRequests).toBe(3)
        expect(value.unpricedRequests).toBe(1)
        expect(value.totalCost).toBeCloseTo(4.85 + 5.85 + 3, 10)
        // Models bucket priced requests only; the unpriced request counts separately.
        expect(Object.keys(value.models).sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
        expect(value.models['deepseek-v4-flash']?.cost).toBeCloseTo(4.85 + 3, 10)
        expect(value.groups['2026-08-17']?.requests).toBe(4)
        expect(Object.keys(value.versions)).toEqual(['deepseek-2026-08-17'])
        expect(value.projects).toEqual(['', '/proj-a', '/proj-b'])
      })
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('filters by project and groups by model', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a' },
        { id: SessionId('b'), cwd: '/proj-b' },
      ]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.logs.set('b', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 }, model: 'deepseek-v4-pro' }]))
      await advanceTicks()
      await untilDashboard(h, value => { expect(value.pricedRequests).toBe(2) })
      const filtered = await dashboard(h.ctx, { project: '/proj-a' })
      expect(filtered.pricedRequests).toBe(1)
      expect(filtered.totalCost).toBeCloseTo(3, 10)
      const byModel = await dashboard(h.ctx, { groupBy: 'model' })
      expect(byModel.groups['deepseek-v4-flash']?.requests).toBe(1)
      expect(byModel.groups['deepseek-v4-pro']?.requests).toBe(1)
      const byWeek = await dashboard(h.ctx, { groupBy: 'week' })
      expect(Object.keys(byWeek.groups)).toEqual(['2026-08-17'])
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('folds only new events past the scan watermark on later ticks', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      await advanceTicks()
      await untilDashboard(h, value => {
        expect(value.totalCost).toBeCloseTo(3, 10)
        expect(value.pricedRequests).toBe(1)
      })
      // A grown log folds only the new request on the next tick.
      h.query.logs.set('a', sessionLog([
        { time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
        { time: OFFPEAK_INSTANT, usage: { inputTokens: 500_000, outputTokens: 0 } },
      ]))
      await advanceTicks()
      await untilDashboard(h, value => {
        expect(value.totalCost).toBeCloseTo(3 + 0.75, 10)
        expect(value.pricedRequests).toBe(2)
      })
      // A repeated tick after the interval adds nothing.
      await advanceTicks()
      await untilDashboard(h, value => { expect(value.totalCost).toBeCloseTo(3.75, 10) })
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('prunes rows of deleted sessions', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a' },
        { id: SessionId('b'), cwd: '/proj-b' },
      ]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.logs.set('b', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 2_000_000, outputTokens: 0 } }]))
      await advanceTicks()
      await untilDashboard(h, value => { expect(value.pricedRequests).toBe(2) })
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      await advanceTicks()
      await untilDashboard(h, value => {
        expect(value.pricedRequests).toBe(1)
        expect(value.totalCost).toBeCloseTo(3, 10)
      })
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('skips malformed usage and mismatched steps in the ledger fold', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', [
        { type: 'step/start', seq: 0, time: PEAK_INSTANT, data: { turn: 1, step: 1 } } as unknown as SessionEvent,
        { type: 'assistant/message', seq: 1, time: PEAK_INSTANT + 1, data: { turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } } as unknown as SessionEvent,
        { type: 'turn/start', seq: 2, time: PEAK_INSTANT + 2, data: { turn: 2 } } as unknown as SessionEvent,
        { type: 'assistant/message', seq: 3, time: PEAK_INSTANT + 3, data: { turn: 2, step: 1, message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } }), usage: { inputTokens: 1_000_000, outputTokens: 0 } } } as unknown as SessionEvent,
      ])
      await advanceTicks()
      // Malformed (no usage) skipped; the mismatched message bills at its own time.
      await untilDashboard(h, value => {
        expect(value.pricedRequests).toBe(1)
        expect(value.totalCost).toBeCloseTo(3, 10)
      })
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('groups by month and project', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a' },
        { id: SessionId('b'), cwd: '/proj-b' },
      ]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.logs.set('b', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 }, model: 'deepseek-v4-pro' }]))
      await advanceTicks()
      await untilDashboard(h, value => { expect(value.pricedRequests).toBe(2) })
      const byMonth = await dashboard(h.ctx, { groupBy: 'month' })
      expect(byMonth.groups['2026-08']?.requests).toBe(2)
      const byProject = await dashboard(h.ctx, { groupBy: 'project' })
      expect(byProject.groups['/proj-a']?.requests).toBe(1)
      expect(byProject.groups['/proj-b']?.requests).toBe(1)
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('filters by billing instant bounds', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', sessionLog([
        { time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
        { time: OFFPEAK_INSTANT, usage: { inputTokens: 500_000, outputTokens: 0 } },
      ]))
      await advanceTicks()
      await untilDashboard(h, value => { expect(value.pricedRequests).toBe(2) })
      // A lower bound after the first request's billing instant excludes it.
      const afterFirst = await dashboard(h.ctx, { from: PEAK_INSTANT + 1, to: OFFPEAK_INSTANT + 1 })
      expect(afterFirst.pricedRequests).toBe(1)
      expect(afterFirst.totalCost).toBeCloseTo(0.75, 10)
      // An upper bound equal to the earlier billing instant excludes both.
      const bounded = await dashboard(h.ctx, { to: PEAK_INSTANT })
      expect(bounded.pricedRequests).toBe(0)
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('serves dashboard reads as pure rollups that never scan the corpus', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      await advanceTicks()
      await untilDashboard(h, value => { expect(value.pricedRequests).toBe(1) })
      const scansAfterReconcile = h.query.listCalls
      const [first, second, third] = await Promise.all([
        dashboard(h.ctx), dashboard(h.ctx, { project: '/proj-a' }), dashboard(h.ctx, { groupBy: 'model' }),
      ])
      expect(first.totalCost).toBeCloseTo(3, 10)
      expect(second.totalCost).toBeCloseTo(3, 10)
      expect(third.groups['deepseek-v4-flash']?.requests).toBe(1)
      expect(h.query.listCalls).toBe(scansAfterReconcile)
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('keeps serving the last reconciled ledger while a pass is gated', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      await advanceTicks()
      await untilDashboard(h, value => { expect(value.totalCost).toBeCloseTo(3, 10) })
      // Block the next background pass before it responds...
      let releaseGate: (() => void) | undefined
      h.query.gate = new Promise<void>(resolve => { releaseGate = resolve })
      h.query.logs.set('a', sessionLog([
        { time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
        { time: OFFPEAK_INSTANT, usage: { inputTokens: 500_000, outputTokens: 0 } },
      ]))
      // One period only: a single tick starts the gated pass. Advancing more
      // periods would merge later ticks into the gated pass (tickAsync waits
      // on the merged promise chain), which cannot settle until the gate
      // releases and would deadlock the advance.
      await vi.advanceTimersByTimeAsync(6_000)
      await untilScans(h.query, 3)
      // ...and the dashboard still returns the previous ledger immediately.
      const duringGate = await dashboard(h.ctx)
      expect(duringGate.totalCost).toBeCloseTo(3, 10)
      expect(duringGate.pricedRequests).toBe(1)
      releaseGate?.()
      await untilDashboard(h, value => {
        expect(value.totalCost).toBeCloseTo(3.75, 10)
        expect(value.pricedRequests).toBe(2)
      })
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('never runs two reconciliation passes at once', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      await advanceTicks()
      await untilDashboard(h, value => { expect(value.pricedRequests).toBe(1) })
      // Gate a pass, then fire one more tick and concurrent dashboard reads:
      // no second listSessions may start while the gated pass is in flight
      // (a single period avoids merging later ticks into the gated pass,
      // which tickAsync would await forever).
      let releaseGate: (() => void) | undefined
      h.query.gate = new Promise<void>(resolve => { releaseGate = resolve })
      const scansBefore = h.query.listCalls
      const reads = Promise.all([dashboard(h.ctx), dashboard(h.ctx)])
      await vi.advanceTimersByTimeAsync(6_000)
      await untilScans(h.query, scansBefore + 1)
      expect(h.query.listCalls).toBe(scansBefore + 1)
      expect(h.query.maxActiveScans).toBe(1)
      releaseGate?.()
      await reads
      await untilDashboard(h, value => { expect(value.pricedRequests).toBe(1) })
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('keeps the last good ledger after a failed pass and recovers on the next tick', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      await advanceTicks()
      await untilDashboard(h, value => { expect(value.totalCost).toBeCloseTo(3, 10) })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        h.query.failSession = 'list'
        await advanceTicks()
        await untilScans(h.query, 3)
        // The failed pass keeps the previous ledger readable.
        const duringFailure = await dashboard(h.ctx)
        expect(duringFailure.totalCost).toBeCloseTo(3, 10)
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session-cost'), expect.any(Error))
        // The next tick recovers.
        h.query.failSession = null
        h.query.logs.set('a', sessionLog([
          { time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
          { time: OFFPEAK_INSTANT, usage: { inputTokens: 500_000, outputTokens: 0 } },
        ]))
        await advanceTicks()
        await untilDashboard(h, value => {
          expect(value.totalCost).toBeCloseTo(3.75, 10)
          expect(value.pricedRequests).toBe(2)
        })
      } finally {
        warnSpy.mockRestore()
      }
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('lets an in-flight pass finish safely when the service is disposed', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a' }]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      await advanceTicks()
      await untilDashboard(h, value => { expect(value.pricedRequests).toBe(1) })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // Gate the next pass, start it with one tick, then release it and
        // dispose: teardown must await the in-flight pass (the domain close
        // effect waits on it), so its writes land on the still-open domain
        // and no 'domain closed' warning is logged.
        let releaseGate: (() => void) | undefined
        h.query.gate = new Promise<void>(resolve => { releaseGate = resolve })
        await vi.advanceTimersByTimeAsync(6_000)
        await untilScans(h.query, 3)
        releaseGate?.()
        await h.fiber.dispose()
        await sleep(50)
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('stops scanning after dispose', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      await untilScans(h.query, 1)
      await h.fiber.dispose()
      const scansAfterDispose = h.query.listCalls
      await vi.advanceTimersByTimeAsync(30_000)
      expect(h.query.listCalls).toBe(scansAfterDispose)
      await rm(h.root, { recursive: true, force: true })
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('resets the ledger when a session id is reused by a fresh lifecycle', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a', createdAt: 1 },
        { id: SessionId('b'), cwd: '/proj-b', createdAt: 1 },
      ]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.logs.set('b', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 500_000, outputTokens: 0 } }]))
      await advanceTicks()
      await untilDashboard(h, value => { expect(value.pricedRequests).toBe(2) })
      // The id is reused by a new lifecycle: the old rows are dropped and the
      // fresh log folds from scratch.
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a', createdAt: 2 },
        { id: SessionId('b'), cwd: '/proj-b', createdAt: 1 },
      ]
      h.query.logs.set('a', sessionLog([
        { time: PEAK_INSTANT, usage: { inputTokens: 2_000_000, outputTokens: 0 } },
      ]))
      await advanceTicks()
      // a refolded from scratch; b's rows untouched.
      await untilDashboard(h, value => {
        expect(value.pricedRequests).toBe(2)
        expect(value.models['deepseek-v4-flash']?.requests).toBe(2)
        expect(value.totalCost).toBeCloseTo(6 + 1.5, 10)
      })
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('bills a message arriving after the scan watermark at its step start', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [{ id: SessionId('a'), cwd: '/proj-a', createdAt: 1 }]
      // Batch 1 ends mid-step: only the step/start is folded.
      h.query.logs.set('a', [
        { type: 'step/start', seq: 0, time: PEAK_INSTANT, data: { turn: 1, step: 1 } } as unknown as SessionEvent,
      ])
      await advanceTicks()
      await untilDashboard(h, value => { expect(value.pricedRequests).toBe(0) })
      // Batch 2 carries the message for that step. The message lands at
      // 05:00Z (Beijing 13:00, off-peak); the step started at 02:00Z (peak).
      // Billing must follow the step start: peak Flash miss rate 3, not the
      // message-time standard rate 1.5.
      h.query.logs.set('a', [
        { type: 'step/start', seq: 0, time: PEAK_INSTANT, data: { turn: 1, step: 1 } } as unknown as SessionEvent,
        { type: 'assistant/message', seq: 1, time: OFFPEAK_INSTANT, data: { turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } }), usage: { inputTokens: 1_000_000, outputTokens: 0 } } } as unknown as SessionEvent,
      ])
      await advanceTicks()
      await untilDashboard(h, value => {
        expect(value.pricedRequests).toBe(1)
        expect(value.totalCost).toBeCloseTo(3, 10)
      })
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('contains unreadable sessions without failing the pass', async () => {
    vi.useFakeTimers()
    let h: Harness | undefined
    try {
      h = await harness()
      h.query.sessions = [
        { id: SessionId('a'), cwd: '/proj-a' },
        { id: SessionId('bad'), cwd: '/proj-b' },
      ]
      h.query.logs.set('a', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.logs.set('bad', sessionLog([{ time: PEAK_INSTANT, usage: { inputTokens: 1_000_000, outputTokens: 0 } }]))
      h.query.failSession = 'bad'
      await advanceTicks()
      await untilDashboard(h, value => {
        expect(value.pricedRequests).toBe(1)
        expect(value.totalCost).toBeCloseTo(3, 10)
      })
    } finally {
      await h?.fiber.dispose()
      if (h !== undefined) await rm(h.root, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })
})
