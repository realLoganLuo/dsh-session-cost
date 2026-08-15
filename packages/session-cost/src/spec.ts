/**
 * Durable storage-domain declaration for the session-cost ledger: the
 * per-request rows table and the per-session scan-watermark table.
 * @module @logan-luo/dsh-session-cost/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { CostRow, SessionScanMeta } from './types.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Runtime schema for one ledger row. */
export const costRowSchema = z.object({
  sessionId: z.string().min(1),
  seq: nonNegativeSafeInteger,
  project: z.string(),
  model: z.string().min(1),
  provider: z.string().min(1),
  billedAt: nonNegativeSafeInteger,
  missTokens: nonNegativeSafeInteger,
  hitTokens: nonNegativeSafeInteger,
  outputTokens: nonNegativeSafeInteger,
  cost: z.number().nonnegative(),
  versionId: z.string().nullable(),
}).strict() satisfies z.ZodType<CostRow>

/** Runtime schema for one session scan watermark. */
export const sessionScanMetaSchema = z.object({
  createdAt: nonNegativeSafeInteger,
  lastSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  openStep: z.object({
    turn: nonNegativeSafeInteger,
    step: nonNegativeSafeInteger,
    startTime: nonNegativeSafeInteger,
  }).nullable(),
}).strict() satisfies z.ZodType<SessionScanMeta>

/** The session-cost ledger domain. */
export const sessionCostDomainSpec = defineDomain({
  name: 'session_cost',
  version: 0,
  tables: {
    rows: domainTable<string, CostRow>(costRowSchema),
    meta: domainTable<string, SessionScanMeta>(sessionScanMetaSchema),
  },
})
