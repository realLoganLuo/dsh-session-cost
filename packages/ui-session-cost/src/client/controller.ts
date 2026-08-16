/**
 * Browser-local object layer over the `cost` Remote: one controller holds the
 * dashboard view (status + last rollup), the current selection (project,
 * time range, grouping), and the refresh verb. The Host owns the ledger and
 * reconciles it in the background; every refresh re-reads the dashboard
 * rollup from the latest reconciled ledger. Per-selection results are cached
 * so switching back to a seen selection shows it immediately while the
 * revalidate round-trip completes.
 * @module @deepseek-ai/dsh-client-session-cost/client/controller
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { DEEPSEEK_BEIJING_OFFSET_MINUTES, dayKeyOf, monthKeyOf, weekKeyOf } from '@logan-luo/dsh-session-cost/pricing'
import type { CostDashboardValue, RollupGroupBy } from '@logan-luo/dsh-session-cost/types'

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
  /** Last successful rollup; kept across refreshes and selection switches while loading. */
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

/** Stable cache key of one selection: every dimension the rollup depends on,
 * plus the resolved range bounds, so a cached `today`/`week`/`month` never
 * leaks across a calendar boundary (the key changes at midnight / week /
 * month rollover and the selection refetches instead of showing stale data). */
function selectionKeyOf(
  selection: DashboardView['selection'],
  bounds: { from?: number; to?: number } = rangeOf(selection.range, Date.now()),
): string {
  return [
    // NUL stands in for `null` so it never collides with the empty project.
    selection.project === null ? '\u0000' : selection.project,
    selection.range,
    bounds.from ?? '',
    bounds.to ?? '',
    selection.groupBy,
  ].join('\u0000')
}

export class DashboardController implements HostObservable<DashboardView> {
  private view: DashboardView = { status: 'idle', selection: EMPTY_SELECTION }
  private readonly listeners = new Set<() => void>()
  /** Last successful rollup per selection; kept across errors and reloads. */
  private readonly cache = new Map<string, CostDashboardValue>()
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

  /**
   * Re-read the rollup under the current selection. The current value (when
   * present) stays published while loading; a failure keeps the last good
   * value and the selection cache. Stale responses never publish.
   */
  async refresh(): Promise<void> {
    if (this.disposed) return
    const token = this.refreshToken + 1
    this.refreshToken = token
    // One bounds computation feeds both the cache key and the request, so a
    // period rollover cannot split them across two calendar instants.
    const bounds = rangeOf(this.view.selection.range, Date.now())
    const key = selectionKeyOf(this.view.selection, bounds)
    this.publish({ ...this.view, status: 'loading' })
    const request = {
      ...bounds,
      groupBy: this.view.selection.groupBy,
      ...this.view.selection.project !== null && { project: this.view.selection.project },
    }
    // Dispose clears the listeners, so publishing after disposal is a no-op
    // for observers; a stale response (a newer refresh superseded this one,
    // or the controller was disposed) is dropped instead of publishing out of
    // order or repopulating the cleared cache.
    try {
      const result = await this.remote.dashboard(request)
      if (token !== this.refreshToken) return
      if (!result.ok) {
        this.publish({ ...this.view, status: 'error', error: 'transport-failed' })
        return
      }
      this.cache.set(key, result.value)
      this.publish({ status: 'ready', value: result.value, selection: this.view.selection })
    } catch {
      if (token === this.refreshToken) {
        this.publish({ ...this.view, status: 'error', error: 'transport-failed' })
      }
    }
  }

  /**
   * Change one selection dimension and reload. A cached rollup for the exact
   * new selection publishes immediately (then revalidates in the background);
   * an uncached selection clears the previous value so no stale data shows
   * under the new filter.
   */
  setSelection(partial: Partial<DashboardView['selection']>): void {
    const next = { ...this.view.selection, ...partial }
    const cached = this.cache.get(selectionKeyOf(next))
    if (cached !== undefined) {
      this.publish({ status: 'ready', value: cached, selection: next })
    } else {
      // No value key on purpose: the previous selection's data must not show
      // under the new filter (exactOptionalPropertyTypes forbids `undefined`).
      this.publish({ status: 'loading', selection: next })
    }
    void this.refresh()
  }

  /** Drop subscribers, clear the selection cache, refuse further work, and
   * invalidate any refresh still in flight so its response cannot repopulate
   * the cache or mutate the view. */
  dispose(): void {
    this.disposed = true
    this.refreshToken += 1
    this.listeners.clear()
    this.cache.clear()
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
