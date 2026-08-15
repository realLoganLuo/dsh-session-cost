// @vitest-environment jsdom
/**
 * Session-cost browser plugin wiring: the apply registers the dock strip, the
 * cost view tab, and the dashboard trigger through hand-faked slots/locale/
 * remote services (the published dsh client packages ship as loader bundles
 * that need the app shell's module table, so this spec drives the apply with
 * plain service fakes instead of materializing them).
 */

import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { CostDockRow } from '../src/client/CostDockRow.tsx'
import { CostViewTab } from '../src/client/CostViewTab.tsx'
import { DashboardTrigger } from '../src/client/DashboardTrigger.tsx'

const DASHBOARD_VALUE = {
  pricedRequests: 1,
  unpricedRequests: 0,
  totalCost: 4.85,
  models: { 'deepseek-v4-flash': { requests: 1, cost: 4.85, inputMissTokens: 1_000_000, inputHitTokens: 500_000, outputTokens: 200_000 } },
  groups: { '2026-08-17': { requests: 1, cost: 4.85 } },
  versions: {},
  projects: ['/proj-a'],
}

interface Entry { name: string; options: { id?: string; order?: number; label?: unknown }; component: unknown }

function fakeCtx() {
  const entries: Entry[] = []
  let mounted = 0
  let unmounted = 0
  const ctx = {
    effect: (fn: () => unknown, _label: string) => {
      const disposer = fn()
      if (typeof disposer === 'function') void (disposer as () => void)()
      return () => {}
    },
    locale: {
      register: () => {},
      bind: () => (_key: string, _params?: Record<string, string | number>) => _key,
    },
    slots: {
      inject: (_name: string, callback: () => { dispose(): void }) => {
        // One-shot install: the declaration exists from the start.
        const installed = callback()
        return () => { installed.dispose() }
      },
      register: (options: Entry['options'], component: unknown) => {
        const entry = { name: 'declared', options, component }
        entries.push(entry)
        return { dispose: () => { const i = entries.indexOf(entry); if (i >= 0) entries.splice(i, 1) } }
      },
    },
    remote: {
      $mount: async () => {
        mounted += 1
        return async () => { unmounted += 1 }
      },
      cost: {
        dashboard: async () => ({ ok: true as const, value: DASHBOARD_VALUE }),
      },
    },
  }
  return { ctx, entries, counts: { mounted: () => mounted, unmounted: () => unmounted } }
}

describe('ui-session-cost browser plugin wiring', () => {
  it('registers the three entries, self-mounts the Remote, and unmounts on disposal', async () => {
    const { ctx, entries, counts } = fakeCtx()
    expect(inject).toEqual(['slots', 'locale', 'remote'])
    const dispose = await apply(ctx as never)
    const dock = entries.filter(entry => entry.options.id === 'cost' && entry.component === CostDockRow)
    const view = entries.filter(entry => entry.options.id === 'cost' && entry.component === CostViewTab)
    const footer = entries.filter(entry => entry.options.id === 'cost-dashboard' && entry.component === DashboardTrigger)
    expect(dock).toHaveLength(1)
    expect(view).toHaveLength(1)
    expect(footer).toHaveLength(1)
    // The view tab's locale label resolves through the bind thunk.
    expect((view[0]?.options.label as () => string)?.()).toBe('view.cost')
    // The dashboard entry's injected face drives the controller through the fake remote.
    // Length asserted above, so the entry is present.
    const injected = (footer[0]!.options as { inject?: unknown }).inject as () => {
      hooks: { costDashboard: { getSnapshot: () => unknown } }
      refresh: () => Promise<void>
      setSelection: (partial: { range: string }) => void
    }
    const face = injected()
    void face.hooks.costDashboard.getSnapshot()
    await face.refresh()
    face.setSelection({ range: 'today' })
    expect(counts.mounted()).toBe(1)
    await dispose()
    expect(counts.unmounted()).toBe(1)
  })

})
