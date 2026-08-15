/**
 * Browser-local object layer over the `cost` Remote: one controller holds the
 * dashboard view (status + last rollup), the current selection (project,
 * time range, grouping), and the refresh verb. The Host owns the ledger;
 * every refresh re-reads the dashboard rollup.
 * @module @deepseek-ai/dsh-client-session-cost/client/controller
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { DEEPSEEK_BEIJING_OFFSET_MINUTES, dayKeyOf, monthKeyOf, weekKeyOf } from '@deepseek-ai/dsh-session-cost/src/pricing.ts'
import type { CostDashboardValue, RollupGroupBy } from '@deepseek-ai/dsh-session-cost/types'

/** The one Remote call this controller needs. */
export interface CostDashboardRemote {
  dashboard: (request: {
    project?: string
    from?: number
    to?: number
    groupBy?: RollupGroupBy
  }) => Promise<RemoteResult<CostDashboardValue>>
}

/** Load state of the dashboard rollup. */
export type DashboardStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Time-range presets over the Beijing calendar. */
export type DashboardRange = 'today' | 'week' | 'month' | 'all'

/** Machine failure code; the surfaces translate it. */
export type DashboardErrorCode = 'transport-failed'

/** Immutable view published to the dashboard surfaces. */
export interface DashboardView {
  status: DashboardStatus
  /** Last successful rollup; kept across refreshes while loading. */
  value?: CostDashboardValue
  /** Machine failure code, present only in the error state. */
  error?: DashboardErrorCode
  /** Active selection (mirrored so components render it without local state). */
  selection: {
    project: string | null
    range: DashboardRange
    groupBy: RollupGroupBy
  }
}

/** `[from, to)` for one preset, in the Beijing calendar. */
export function rangeOf(range: DashboardRange, now: number): { from?: number; to?: number } {
  const offsetMs = DEEPSEEK_BEIJING_OFFSET_MINUTES * 60_000
  const dayStart = (key: string): number => Date.parse(`${key}T00:00:00Z`) - offsetMs
  switch (range) {
    case 'today':
      return { from: dayStart(dayKeyOf(now)) }
    case 'week':
      return { from: dayStart(weekKeyOf(now)) }
    case 'month':
      return { from: dayStart(`${monthKeyOf(now)}-01`) }
    case 'all':
      return {}
  }
}

/** Immutable empty selection. */
const EMPTY_SELECTION: DashboardView['selection'] = { project: null, range: 'all', groupBy: 'day' }

export class DashboardController implements HostObservable<DashboardView> {
  private view: DashboardView = { status: 'idle', selection: EMPTY_SELECTION }
  private readonly listeners = new Set<() => void>()
  private disposed = false
  /** Monotonic refresh ordinal: only the latest response publishes. */
  private refreshToken = 0

  /**
   * @param remote - the generated `cost` namespace face.
   */
  constructor(private readonly remote: CostDashboardRemote) {}

  getSnapshot = (): DashboardView => this.view

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Reload the rollup under the current selection. */
  async refresh(): Promise<void> {
    if (this.disposed) return
    const token = this.refreshToken + 1
    this.refreshToken = token
    this.publish({ ...this.view, status: 'loading' })
    const request = {
      ...rangeOf(this.view.selection.range, Date.now()),
      groupBy: this.view.selection.groupBy,
      ...this.view.selection.project !== null && { project: this.view.selection.project },
    }
    // Dispose clears the listeners, so publishing after disposal is a no-op
    // for observers; a stale response (a newer refresh superseded this one)
    // is dropped instead of publishing out of order.
    try {
      const result = await this.remote.dashboard(request)
      if (token !== this.refreshToken) return
      if (!result.ok) {
        this.publish({ ...this.view, status: 'error', error: 'transport-failed' })
        return
      }
      this.publish({ status: 'ready', value: result.value, selection: this.view.selection })
    } catch {
      if (token === this.refreshToken) {
        this.publish({ ...this.view, status: 'error', error: 'transport-failed' })
      }
    }
  }

  /** Change one selection dimension and reload. */
  setSelection(partial: Partial<DashboardView['selection']>): void {
    this.publish({
      ...this.view,
      selection: { ...this.view.selection, ...partial },
    })
    void this.refresh()
  }

  /** Drop subscribers and refuse further work. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  private publish(view: DashboardView): void {
    this.view = view
    // Snapshot the subscriber set: listeners that subscribe or unsubscribe
    // during a notification must not change the current round.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[session-cost] dashboard subscriber threw:', error)
      }
    }
  }
}
