// Session cost accounting, node half: the costStats projection unit and the
// durable ledger service behind the `cost` Remote namespace. The browser half
// renders the projection through the standard feed and calls `cost.dashboard`
// for cross-session rollups.
// @module @logan-luo/dsh-session-cost

import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
// Type-only: pulls the sessionQuery Context merge (ctx.sessionQuery).
import type {} from '@deepseek-ai/dsh-session-query'
// Type-only: pulls the timer mixin Context merge (ctx.interval).
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { reconcileLedger, rollup, type SessionQueryScanSource } from './ledger.ts'
import { sessionCostProjectionDefinition } from './projection.ts'
import { sessionCostDomainSpec } from './spec.ts'
import type { CostDashboardRequest, CostDashboardValue, CostRow, SessionScanMeta } from './types.ts'

/** Deployment-varying ledger tunables. */
export interface SessionCostConfig {
  /**
   * Background ledger reconcile period (ms): the ledger service folds new
   * session log events into the durable rows this often, starting with a
   * warm-up pass at startup. Dashboard calls read the latest successfully
   * reconciled ledger and never trigger a scan themselves. Defaults to 5000.
   */
  reconcileIntervalMs: number
}

/**
 * Rows covered by a successfully written watermark — a session's committed
 * prefix. Rows past a session's `lastSeq`, or in a session without any
 * watermark, are the tail of a pass that failed (or skipped the session's
 * read) before its meta write; they stay hidden until a pass actually
 * commits them. Used for the startup snapshot and after every pass.
 */
function committedRows(
  rows: KvTable<string, CostRow>,
  meta: KvTable<string, SessionScanMeta>,
): CostRow[] {
  const committed: CostRow[] = []
  for (const [, row] of rows.entries()) {
    const watermark = meta.get(row.sessionId)
    if (watermark !== undefined && row.seq <= watermark.lastSeq) committed.push(row)
  }
  return committed
}

/** Durable ledger and dashboard service over the sessionQuery corpus. */
export class SessionCostService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionQuery', 'sessionProjections', 'timer']

  /** Loader validation for the ledger tunables. */
  static Config: s<SessionCostConfig> = s.object({
    reconcileIntervalMs: s.number().step(1).min(1_000).default(5_000),
  })

  private readonly reconcileIntervalMs: number
  private rows?: KvTable<string, CostRow>
  private meta?: KvTable<string, SessionScanMeta>
  /** The last successfully reconciled ledger, published atomically per pass. */
  private snapshot: readonly CostRow[] = []
  private inFlight: Promise<void> | null = null

  /**
   * @param ctx - Host context carrying the storage domain, the session query
   * engine, the projection registry, and the timer mixin.
   * @param config - deployment-varying ledger tunables.
   */
  constructor(ctx: Context, config: SessionCostConfig = { reconcileIntervalMs: 5_000 }) {
    super(ctx, 'cost')
    this.reconcileIntervalMs = config.reconcileIntervalMs
  }

  /** Open the ledger domain, mount the projection unit, and start background reconciliation. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sessionCostDomainSpec)
    this.ctx.effect(() => async () => {
      // Let an active pass finish its writes before the domain closes: the
      // merged promise never rejects, so a failed pass cannot break teardown.
      await this.inFlight
      await domain.close()
    }, 'session-cost: domain close')
    const rows = domain.table('rows')
    this.rows = rows
    const meta = domain.table('meta')
    this.meta = meta
    // Serve the durable ledger immediately — a restart or a failed warm-up
    // must not hide rows persisted by an earlier run — but only rows covered
    // by a successfully written watermark (see committedRows).
    this.snapshot = committedRows(rows, meta)
    this.ctx.effect(
      () => this.ctx.sessionProjections.register(sessionCostProjectionDefinition),
      'session-cost: costStats unit',
    )
    // Background reconciliation: one warm-up pass now, then a tick every
    // reconcileIntervalMs. The interval disposer is fiber-bound, so dispose or
    // hot-reload cancels the next tick; a pass already in flight is reused,
    // never overlapped.
    void this.runReconcile()
    this.ctx.effect(
      () => this.ctx.interval(() => { void this.runReconcile() }, this.reconcileIntervalMs),
      'session-cost: reconcile tick',
    )
  }

  /** Adapt the query engine to the scan face (branded ids, dropped signals). */
  private scanSource(): SessionQueryScanSource {
    const query = this.ctx.sessionQuery
    return {
      listSessions: async () => {
        const records = await query.listSessions()
        return records.map(record => ({
          header: {
            id: String(record.header.id),
            createdAt: record.header.createdAt,
            ...record.header.cwd !== undefined && { cwd: record.header.cwd },
          },
        }))
      },
      readSession: async (id: string) => {
        const snapshot = await query.readSession(id as SessionId)
        return { events: snapshot.events }
      },
    }
  }

  /**
   * Run one ledger reconciliation pass, merging with any pass already in
   * flight. A failed pass logs a warning, keeps the last good ledger readable,
   * and retries on the next tick; this method never rejects, so background
   * ticks cannot produce unhandled promise rejections.
   */
  private async runReconcile(): Promise<void> {
    const running = this.inFlight
    if (running !== null) {
      await running
      return
    }
    try {
      const tables = this.requireTables()
      const pass = reconcileLedger(this.scanSource(), tables)
      // The merged promise never rejects, so concurrent ticks cannot observe
      // an unhandled rejection; the owner below awaits the raw pass to tell a
      // completed pass from a failed one.
      this.inFlight = pass.then(
        () => undefined,
        () => undefined,
      )
      try {
        await pass
        // Only a completed pass publishes a new snapshot: a dashboard read
        // during a scan keeps seeing the previous consistent ledger instead
        // of a partially folded one, and a failed pass keeps it too. The
        // watermark filter still applies — a pass that contained an
        // unreadable session must not republish that session's uncovered
        // rows from an earlier failed pass.
        this.snapshot = committedRows(tables.rows, tables.meta)
      } catch (error: unknown) {
        console.warn('[session-cost] background ledger reconcile failed:', error)
      } finally {
        this.inFlight = null
      }
      /* v8 ignore next 3 -- unreachable: requireTables only throws before init, and no pass runs then */
    } catch (error: unknown) {
      console.warn('[session-cost] background ledger reconcile failed:', error)
    }
  }

  private requireTables(): { rows: KvTable<string, CostRow>; meta: KvTable<string, SessionScanMeta> } {
    const rows = this.rows
    const meta = this.meta
    /* v8 ignore next 4 -- unreachable: both tables are set in init before any method runs */
    if (rows === undefined || meta === undefined) {
      throw new Error('session-cost: ledger tables not open')
    }
    return { rows, meta }
  }

  /**
   * One dashboard rollup over the latest successfully reconciled ledger
   * snapshot. Pure read: the background reconcile owns scanning, so this
   * never waits on or triggers a sessionQuery pass, and a scan in progress
   * cannot leak a partially folded ledger.
   * @param request - selection and grouping; defaults to everything grouped by day.
   * @returns the rollup value.
   */
  @Remote('dashboard')
  async dashboard(request: CostDashboardRequest): Promise<CostDashboardValue> {
    this.requireTables()
    return rollup(
      this.snapshot,
      {
        ...request.project !== undefined && { project: request.project },
        ...request.from !== undefined && { from: request.from },
        ...request.to !== undefined && { to: request.to },
      },
      request.groupBy ?? 'day',
    )
  }
}

export default SessionCostService
