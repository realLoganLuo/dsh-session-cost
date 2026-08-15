// Shared session-cost vocabulary: the `costStats` projection value consumed
// by the Host projection unit and the browser surfaces. Client-safe types
// only — no runtime code beyond the schema, which lives with the unit.

/** One model's accumulated priced requests. */
export interface ModelCostBucket {
  /** Requests priced against an official card. */
  requests: number
  /** Summed CNY estimate over those requests. */
  cost: number
  /** Summed cache-miss input tokens. */
  inputMissTokens: number
  /** Summed cache-hit input tokens. */
  inputHitTokens: number
  /** Summed output tokens (reasoning tokens included per DeepSeek billing). */
  outputTokens: number
}

/** One grouped bucket of accumulated requests (day/week/month/model/project keys). */
export interface DayCostBucket {
  /** Requests in the bucket (priced and unpriced). */
  requests: number
  /** Summed CNY estimate over priced requests in the bucket. */
  cost: number
}

/**
 * The `costStats` projection value: whole-log billed requests, priced from
 * each request's model, billing instant, and the official rate-card version
 * in force at that instant.
 *
 * The value is a reference figure, never an invoice: a session that switched
 * models or crossed a tariff boundary prices every request under its own
 * version, while requests from models outside the official card are counted
 * as unpriced rather than guessed.
 */
export interface SessionCostProjection {
  /** Usage-bearing requests priced against an official rate card. */
  pricedRequests: number
  /** Usage-bearing requests whose model/provider has no official card. */
  unpricedRequests: number
  /** Summed CNY estimate over every priced request. */
  totalCost: number
  /** Per-model buckets, keyed by the provider model id. */
  models: Readonly<Record<string, ModelCostBucket>>
  /** Per-day buckets, keyed by `YYYY-MM-DD` in the billing calendar. */
  days: Readonly<Record<string, DayCostBucket>>
  /** Rate-card version id -> priced requests using it. */
  versions: Readonly<Record<string, number>>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Whole-log billed requests priced per request against the official rate card. */
    costStats: SessionCostProjection
  }
}


/** One priced or unpriced request in the durable cost ledger. */
export interface CostRow {
  /** Owning session id. */
  sessionId: string
  /** Event seq of the usage-bearing assistant/message. */
  seq: number
  /** Session working directory (the project key). */
  project: string
  /** Provider model id. */
  model: string
  /** Provider route id. */
  provider: string
  /** Billing instant (epoch ms). */
  billedAt: number
  /** Cache-miss input tokens. */
  missTokens: number
  /** Cache-hit input tokens. */
  hitTokens: number
  /** Output tokens. */
  outputTokens: number
  /** CNY estimate; 0 for unpriced requests. */
  cost: number
  /** Rate-version id that produced the cost, or null when unpriced. */
  versionId: string | null
}

/** One session's scan watermark: rows are folded past this seq. */
export interface SessionScanMeta {
  /** Session createdAt that produced the watermark; a mismatch means a fresh lifecycle under a reused id. */
  createdAt: number
  /** Highest folded event seq; -1 before the first fold. */
  lastSeq: number
  /** The last step's boundary, so a batch split mid-step bills at the step start. */
  openStep: { turn: number; step: number; startTime: number } | null
}

/** Grouping dimension for the dashboard rollup. */
export type RollupGroupBy = 'day' | 'week' | 'month' | 'model' | 'project'

/** Selection over ledger rows. */
export interface RollupFilter {
  /** Restrict to one project (cwd). */
  project?: string
  /** Inclusive lower bound on the billing instant (epoch ms). */
  from?: number
  /** Exclusive upper bound on the billing instant (epoch ms). */
  to?: number
}

/** One dashboard invocation: selection plus grouping. */
export interface CostDashboardRequest {
  /** Restrict to one project (cwd). */
  project?: string
  /** Inclusive lower bound on the billing instant (epoch ms). */
  from?: number
  /** Exclusive upper bound on the billing instant (epoch ms). */
  to?: number
  /** Grouping dimension for the `groups` buckets; defaults to `day`. */
  groupBy?: RollupGroupBy
}

/** The dashboard rollup value: totals, per-model, per-group, and versions. */
export interface CostDashboardValue {
  /** Priced requests in the selection. */
  pricedRequests: number
  /** Unpriced requests in the selection. */
  unpricedRequests: number
  /** Summed CNY estimate over priced requests. */
  totalCost: number
  /** Per-model buckets in the selection. */
  models: Readonly<Record<string, ModelCostBucket>>
  /** Per-group buckets (keys depend on the requested grouping). */
  groups: Readonly<Record<string, DayCostBucket>>
  /** Rate-version id -> priced requests in the selection. */
  versions: Readonly<Record<string, number>>
  /** Distinct projects across the whole ledger (for the selector). */
  projects: readonly string[]
}
