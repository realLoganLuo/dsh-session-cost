/** Dashboard controller: refresh/selection lifecycle over the fake cost Remote. */

import { describe, expect, it, vi } from 'vitest'
import { DashboardController, rangeOf, type CostDashboardRemote, type DashboardRange } from '../src/client/controller.ts'
import type { CostDashboardValue } from '@deepseek-ai/dsh-session-cost/types'

const VALUE: CostDashboardValue = {
  pricedRequests: 1,
  unpricedRequests: 0,
  totalCost: 4.85,
  models: {},
  groups: {},
  versions: {},
  projects: ['/proj-a'],
}

function fakeRemote(overrides: Partial<CostDashboardRemote> = {}): {
  remote: CostDashboardRemote
  calls: Array<Record<string, unknown>>
} {
  const calls: Array<Record<string, unknown>> = []
  const remote: CostDashboardRemote = {
    dashboard: (request: Parameters<CostDashboardRemote['dashboard']>[0]) => {
      calls.push(request)
      return Promise.resolve({ ok: true as const, value: VALUE })
    },
    ...overrides,
  }
  return { remote, calls }
}

describe('DashboardController', () => {
  it('refreshes from idle to ready and publishes the value', async () => {
    const { remote, calls } = fakeRemote()
    const controller = new DashboardController(remote)
    expect(controller.getSnapshot().status).toBe('idle')
    await controller.refresh()
    const view = controller.getSnapshot()
    expect(view.status).toBe('ready')
    expect(view.value).toBe(VALUE)
    expect(calls[0]).toEqual({ groupBy: 'day' })
  })

  it('sends the range bounds and project with the selection', async () => {
    const { remote, calls } = fakeRemote()
    const controller = new DashboardController(remote)
    controller.setSelection({ range: 'today', groupBy: 'model', project: '/proj-a' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    const request = calls[calls.length - 1] as { from?: number; groupBy?: string; project?: string }
    expect(request.groupBy).toBe('model')
    expect(request.project).toBe('/proj-a')
    expect(typeof request.from).toBe('number')
  })

  it('publishes the error state on a transport failure', async () => {
    const { remote } = fakeRemote({
      dashboard: () => Promise.resolve({ ok: false as const, error: { code: 'internal' as const, message: 'boom', details: {} } }),
    })
    const controller = new DashboardController(remote)
    await controller.refresh()
    const view = controller.getSnapshot()
    expect(view.status).toBe('error')
    expect(view.error).toBe('transport-failed')
  })

  it('contains a rejected remote call', async () => {
    const { remote } = fakeRemote({
      dashboard: () => Promise.reject(new Error('boom')),
    })
    const controller = new DashboardController(remote)
    await controller.refresh()
    expect(controller.getSnapshot().status).toBe('error')
  })

  it('drops a stale response when a newer refresh supersedes it', async () => {
    const gates: Array<(value: { ok: true; value: CostDashboardValue }) => void> = []
    const { remote } = fakeRemote({
      dashboard: () => new Promise<{ ok: true; value: CostDashboardValue }>((resolve) => { gates.push(resolve) }),
    })
    const controller = new DashboardController(remote)
    const first = controller.refresh()
    const second = controller.refresh()
    // The first (stale) response settles first: it must not publish.
    gates[0]?.({ ok: true, value: VALUE })
    await first
    expect(controller.getSnapshot().status).toBe('loading')
    // The current response settles and publishes.
    gates[1]?.({ ok: true, value: VALUE })
    await second
    expect(controller.getSnapshot().status).toBe('ready')
  })

  it('unsubscribes listeners', async () => {
    const { remote } = fakeRemote()
    const controller = new DashboardController(remote)
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)
    unsubscribe()
    await controller.refresh()
    expect(listener).not.toHaveBeenCalled()
  })

  it('contains a throwing subscriber', async () => {
    const { remote } = fakeRemote()
    const controller = new DashboardController(remote)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      controller.subscribe(() => { throw new Error('boom') })
      await controller.refresh()
      expect(controller.getSnapshot().status).toBe('ready')
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('drops a stale rejection when a newer refresh supersedes it', async () => {
    let calls = 0
    let resolveSecond: ((value: { ok: true; value: CostDashboardValue }) => void) | undefined
    const { remote } = fakeRemote({
      dashboard: () => {
        calls += 1
        if (calls === 1) return Promise.reject(new Error('boom'))
        return new Promise<{ ok: true; value: CostDashboardValue }>((resolve) => { resolveSecond = resolve })
      },
    })
    const controller = new DashboardController(remote)
    const first = controller.refresh()
    const second = controller.refresh()
    // The stale rejection must not publish over the still-running refresh.
    await first
    expect(controller.getSnapshot().status).toBe('loading')
    resolveSecond?.({ ok: true, value: VALUE })
    await second
    expect(controller.getSnapshot().status).toBe('ready')
  })

  it('stops publishing after dispose', async () => {
    const { remote } = fakeRemote()
    const controller = new DashboardController(remote)
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.dispose()
    await controller.refresh()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('rangeOf', () => {
  const NOW = Date.parse('2026-08-17T05:00:00Z') // Beijing 2026-08-17 13:00
  it('bounds today to the Beijing midnight', () => {
    const range = rangeOf('today', NOW)
    expect(range.from).toBe(Date.parse('2026-08-16T16:00:00Z'))
    expect(range.to).toBeUndefined()
  })
  it('bounds the week to Monday midnight', () => {
    const range = rangeOf('week', NOW)
    // 2026-08-17 is a Monday.
    expect(range.from).toBe(Date.parse('2026-08-16T16:00:00Z'))
  })
  it('bounds the month to the first', () => {
    const range = rangeOf('month', NOW)
    expect(range.from).toBe(Date.parse('2026-07-31T16:00:00Z'))
  })
  it('leaves the all preset unbounded', () => {
    expect(rangeOf('all', NOW)).toEqual({})
  })
  it('covers every preset', () => {
    const presets: readonly DashboardRange[] = ['today', 'week', 'month', 'all']
    for (const preset of presets) rangeOf(preset, NOW)
  })
})
