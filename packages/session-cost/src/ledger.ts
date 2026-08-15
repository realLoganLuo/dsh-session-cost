// The durable cost ledger: per-request rows folded from session logs, pure
// rollups over those rows, and the reconciliation scan over the sessionQuery
// corpus. The service owns the storage tables; this module owns the math.

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { billableUsageOf, priceRequest } from './billing.ts'
import { dayKeyOf, monthKeyOf, weekKeyOf } from './pricing.ts'
import type {
  CostDashboardValue, CostRow, DayCostBucket, ModelCostBucket, RollupFilter, RollupGroupBy, SessionScanMeta,
} from './types.ts'

/** The open step's billing boundary during a log fold. */
interface OpenStep {
  turn: number
  step: number
  startTime: number
}

/**
 * Fold one session's raw log into ledger rows. Every usage-bearing
 * `assistant/message` produces exactly one row (priced or unpriced), using
 * the same billing-instant semantics as the costStats projection: the open
 * step's start when the event's turn/step matches, the message time
 * otherwise.
 * @param events - the session's raw log, in seq order.
 * @param sessionId - owning session id.
 * @param project - the session's working directory (the project key).
 * @param openStep - the open step carried across a scan watermark; null for a full fold.
 * @returns ledger rows in seq order.
 */
export function foldLedgerRows(
  events: readonly SessionEvent[],
  sessionId: string,
  project: string,
  openStep: SessionScanMeta['openStep'] = null,
): CostRow[] {
  const rows: CostRow[] = []
  let open: OpenStep | null = openStep
  for (const event of events) {
    if (event.type === 'step/start') {
      open = { turn: event.data.turn, step: event.data.step, startTime: event.time }
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = billableUsageOf(event.data.usage)
    if (usage === null) continue
    const source = event.data.message.source
    const billedAt = open !== null && open.turn === event.data.turn && open.step === event.data.step
      ? open.startTime
      : event.time
    const request = priceRequest(source.model, source.provider, billedAt, usage)
    rows.push({
      sessionId,
      seq: event.seq,
      project,
      model: request.model,
      provider: request.provider,
      billedAt: request.billedAt,
      missTokens: request.missTokens,
      hitTokens: request.hitTokens,
      outputTokens: request.outputTokens,
      cost: request.cost,
      versionId: request.versionId,
    })
  }
  return rows
}

/** Group key of one row under the requested dimension. */
function groupKeyOf(row: CostRow, groupBy: RollupGroupBy): string {
  switch (groupBy) {
    case 'day': return dayKeyOf(row.billedAt)
    case 'week': return weekKeyOf(row.billedAt)
    case 'month': return monthKeyOf(row.billedAt)
    case 'model': return row.model
    case 'project': return row.project
  }
}

const emptyBucket = (): DayCostBucket => ({ requests: 0, cost: 0 })

const emptyModelBucket = (): ModelCostBucket => ({
  requests: 0, cost: 0, inputMissTokens: 0, inputHitTokens: 0, outputTokens: 0,
})

/**
 * Roll ledger rows up into one dashboard value under a selection and a
 * grouping dimension.
 * @param rows - ledger rows (already reconciled).
 * @param filter - selection over project and billing instant.
 * @param groupBy - grouping dimension for the `groups` buckets.
 * @returns the rollup value.
 */
export function rollup(
  rows: readonly CostRow[],
  filter: RollupFilter,
  groupBy: RollupGroupBy,
): CostDashboardValue {
  let pricedRequests = 0
  let unpricedRequests = 0
  let totalCost = 0
  const models: Record<string, ModelCostBucket> = {}
  const groups: Record<string, DayCostBucket> = {}
  const versions: Record<string, number> = {}
  const projects = new Set<string>()
  for (const row of rows) projects.add(row.project)
  for (const row of rows) {
    if (filter.project !== undefined && row.project !== filter.project) continue
    if (filter.from !== undefined && row.billedAt < filter.from) continue
    if (filter.to !== undefined) {
      if (row.billedAt >= filter.to) continue
    }

    if (row.versionId !== null) pricedRequests += 1
    else unpricedRequests += 1
    totalCost += row.cost
    if (row.versionId !== null) {
      const model = models[row.model] ?? emptyModelBucket()
      models[row.model] = {
        requests: model.requests + 1,
        cost: model.cost + row.cost,
        inputMissTokens: model.inputMissTokens + row.missTokens,
        inputHitTokens: model.inputHitTokens + row.hitTokens,
        outputTokens: model.outputTokens + row.outputTokens,
      }
    }
    const key = groupKeyOf(row, groupBy)
    const group = groups[key] ?? emptyBucket()
    groups[key] = { requests: group.requests + 1, cost: group.cost + row.cost }
    if (row.versionId !== null) {
      versions[row.versionId] = (versions[row.versionId] ?? 0) + 1
    }
  }
  return { pricedRequests, unpricedRequests, totalCost, models, groups, versions, projects: [...projects].sort() }
}

/** The storage tables the ledger owns, as an interface for the scan. */
export interface LedgerTables {
  rows: {
    get(key: string): CostRow | undefined
    put(key: string, value: CostRow): Promise<void>
    delete(key: string): Promise<boolean>
    keys(): IterableIterator<string>
  }
  meta: {
    get(key: string): SessionScanMeta | undefined
    put(key: string, value: SessionScanMeta): Promise<void>
    delete(key: string): Promise<boolean>
    keys(): IterableIterator<string>
  }
}

/** The sessionQuery face the scan needs, as an interface for tests. */
export interface SessionQueryScanSource {
  listSessions(): Promise<readonly { header: { id: string; cwd?: string; createdAt: number } }[]>
  readSession(sessionId: string): Promise<{ events: readonly SessionEvent[] }>
}

/** Outcome of one reconciliation pass. */
export interface ReconcileStats {
  /** Sessions whose logs were read and folded. */
  scanned: number
  /** Ledger rows added. */
  added: number
  /** Ledger rows pruned for sessions that no longer exist. */
  pruned: number
  /** Sessions skipped because their log could not be read. */
  failed: number
}

/**
 * Reconcile the ledger against the sessionQuery corpus: fold new events of
 * every known session past its scan watermark, and prune rows of sessions
 * that no longer exist.
 * @param source - the sessionQuery face.
 * @param tables - the ledger tables.
 * @returns per-pass counters.
 */
export async function reconcileLedger(
  source: SessionQueryScanSource,
  tables: LedgerTables,
): Promise<ReconcileStats> {
  const stats: ReconcileStats = { scanned: 0, added: 0, pruned: 0, failed: 0 }
  const records = await source.listSessions()
  const alive = new Set<string>()
  const scanOne = async (record: { header: { id: string; cwd?: string; createdAt: number } }): Promise<void> => {
    const id = record.header.id
    alive.add(id)
    // One unreadable log must not sink the whole pass: skip and count it.
    let log: { events: readonly SessionEvent[] }
    try {
      log = await source.readSession(id)
    } catch {
      stats.failed += 1
      return
    }
    const meta = tables.meta.get(id)
    const createdAt = record.header.createdAt
    const freshLifecycle = meta !== undefined && meta.createdAt !== createdAt
    if (freshLifecycle) {
      // A reused id under a new lifecycle: drop the stale rows and refold.
      for (const key of tables.rows.keys()) {
        if (sessionIdOf(key) === id) {
          await tables.rows.delete(key)
          stats.pruned += 1
        }
      }
    }
    const from = meta === undefined || freshLifecycle ? -1 : meta.lastSeq
    const newEvents = log.events.filter(event => event.seq > from)
    if (newEvents.length === 0) return
    const rows = foldLedgerRows(newEvents, id, record.header.cwd ?? '', meta?.openStep ?? null)
    for (const row of rows) {
      await tables.rows.put(rowKey(id, row.seq), row)
      stats.added += 1
    }
    /* v8 ignore next 3 -- unreachable: the fold only runs when new events exist */
    const lastSeq = log.events[log.events.length - 1]?.seq ?? from
    await tables.meta.put(id, { createdAt, lastSeq, openStep: openStepOf(newEvents, meta?.openStep ?? null) })
    stats.scanned += 1
  }
  // Bounded read concurrency: the sessionQuery backend itself limits persisted
  // inspection; this pool mirrors that posture for the fold.
  let cursor = 0
  const workers = Array.from({ length: RECONCILE_READ_CONCURRENCY }, async () => {
    while (cursor < records.length) {
      const record = records[cursor]
      cursor += 1
      /* v8 ignore next 2 -- unreachable: read and increment share one synchronous step */
      if (record !== undefined) await scanOne(record)
    }
  })
  await Promise.all(workers)
  for (const key of tables.rows.keys()) {
    if (!alive.has(sessionIdOf(key))) {
      await tables.rows.delete(key)
      stats.pruned += 1
    }
  }
  for (const key of tables.meta.keys()) {
    if (!alive.has(key)) await tables.meta.delete(key)
  }
  return stats
}

/**
 * Internal scheduling constant, not deployment configuration: how many
 * session logs the reconcile pass reads concurrently.
 */
const RECONCILE_READ_CONCURRENCY = 4

/** The open step after processing a batch: the batch's last step/start, or the carried one. */
function openStepOf(events: readonly SessionEvent[], carried: SessionScanMeta['openStep']): SessionScanMeta['openStep'] {
  let open = carried
  for (const event of events) {
    if (event.type === 'step/start') {
      open = { turn: event.data.turn, step: event.data.step, startTime: event.time }
    }
  }
  return open
}

/** Ledger row key: session id and seq, unambiguous under slicing. */
export function rowKey(sessionId: string, seq: number): string {
  return `${sessionId}\u0000${seq}`
}

/** The session id portion of a row key. */
export function sessionIdOf(key: string): string {
  const separator = key.indexOf('\u0000')
  /* v8 ignore next 2 -- unreachable: row keys are always minted with the separator */
  return separator === -1 ? key : key.slice(0, separator)
}
