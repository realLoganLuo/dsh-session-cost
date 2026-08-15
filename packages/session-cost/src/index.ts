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
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { reconcileLedger, rollup, type SessionQueryScanSource } from './ledger.ts'
import { sessionCostProjectionDefinition } from './projection.ts'
import { sessionCostDomainSpec } from './spec.ts'
import type { CostDashboardRequest, CostDashboardValue, CostRow, SessionScanMeta } from './types.ts'

/** Deployment-varying ledger tunables. */
export interface SessionCostConfig {
  /**
   * Dashboard calls reconcile the ledger at most this often (ms). Fresh live
   * events still reach the browser instantly through the projection channel.
   * Defaults to 5000.
   */
  reconcileIntervalMs: number
}

/** Durable ledger and dashboard service over the sessionQuery corpus. */
export class SessionCostService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionQuery', 'sessionProjections']

  /** Loader validation for the ledger tunables. */
  static Config: s<SessionCostConfig> = s.object({
    reconcileIntervalMs: s.number().step(1).min(1).default(5_000),
  })

  private readonly reconcileIntervalMs: number
  private rows?: KvTable<string, CostRow>
  private meta?: KvTable<string, SessionScanMeta>
  private lastReconciledAt = 0
  private inFlight: Promise<void> | null = null

  /**
   * @param ctx - Host context carrying the storage domain, the session query
   * engine, and the projection registry.
   * @param config - deployment-varying ledger tunables.
   */
  constructor(ctx: Context, config: SessionCostConfig = { reconcileIntervalMs: 5_000 }) {
    super(ctx, 'cost')
    this.reconcileIntervalMs = config.reconcileIntervalMs
  }

  /** Open the ledger domain and mount the projection unit. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sessionCostDomainSpec)
    this.ctx.effect(() => async () => {
      await domain.close()
    }, 'session-cost: domain close')
    this.rows = domain.table('rows')
    this.meta = domain.table('meta')
    this.ctx.effect(
      () => this.ctx.sessionProjections.register(sessionCostProjectionDefinition),
      'session-cost: costStats unit',
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
   * Reconcile the ledger against the sessionQuery corpus, throttled.
   * An in-flight pass is awaited rather than restarted; a failed pass retries
   * on the next call after the interval.
   */
  private async reconcile(): Promise<void> {
    const now = Date.now()
    if (this.inFlight !== null) return this.inFlight
    if (now - this.lastReconciledAt < this.reconcileIntervalMs) return
    const tables = this.requireTables()
    this.lastReconciledAt = now
    this.inFlight = reconcileLedger(this.scanSource(), tables).then(
      () => undefined,
      (error: unknown) => {
        this.lastReconciledAt = 0
        throw error
      },
    )
    try {
      await this.inFlight
    } finally {
      this.inFlight = null
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
   * One dashboard rollup over the reconciled ledger.
   * @param request - selection and grouping; defaults to everything grouped by day.
   * @returns the rollup value.
   */
  @Remote('dashboard')
  async dashboard(request: CostDashboardRequest): Promise<CostDashboardValue> {
    await this.reconcile()
    const { rows } = this.requireTables()
    return rollup(
      [...rows.entries()].map(([, row]) => row),
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
