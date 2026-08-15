/**
 * The `costStats` projection unit: a pure fold of usage-bearing
 * `assistant/message` events into per-model, per-day, and per-rate-version
 * cost buckets, priced from each request's model and billing instant against
 * the official versioned rate card.
 *
 * Every `assistant/message` carrying provider usage is a real billable
 * request, including messages a later compaction shadowed and compaction
 * summaries themselves — the fold counts the log, not the surface. Requests
 * whose model has no official card are counted as unpriced instead of
 * guessed. The billing instant is the step's `step/start` time when the
 * event's turn/step matches the open step (peak windows are calendarized by
 * request start), falling back to the message time.
 *
 * @module @logan-luo/dsh-session-cost/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { billableUsageOf, priceRequest, type PricedRequest } from './billing.ts'
import { dayKeyOf } from './pricing.ts'
import type { DayCostBucket, ModelCostBucket, SessionCostProjection } from './types.ts'

const modelBucketSchema = z.object({
  requests: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  inputMissTokens: z.number().int().nonnegative(),
  inputHitTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
}).strict()

const dayBucketSchema = z.object({
  requests: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
}).strict()

/** Wire schema for the `costStats` projection value. */
export const sessionCostSchema = z.object({
  pricedRequests: z.number().int().nonnegative(),
  unpricedRequests: z.number().int().nonnegative(),
  totalCost: z.number().nonnegative(),
  models: z.record(z.string(), modelBucketSchema),
  days: z.record(z.string(), dayBucketSchema),
  versions: z.record(z.string(), z.number().int().nonnegative()),
}).strict() satisfies z.ZodType<SessionCostProjection>

/** Fold state: the published value plus the in-flight step boundary. */
interface SessionCostState extends SessionCostProjection {
  /** The open step's boundary facts; null outside a step. */
  openStep: { turn: number; step: number; startTime: number } | null
}

const emptyModelBucket = (): ModelCostBucket => ({
  requests: 0, cost: 0, inputMissTokens: 0, inputHitTokens: 0, outputTokens: 0,
})

const emptyDayBucket = (): DayCostBucket => ({ requests: 0, cost: 0 })

const init = (): SessionCostState => ({
  pricedRequests: 0,
  unpricedRequests: 0,
  totalCost: 0,
  models: {},
  days: {},
  versions: {},
  openStep: null,
})


/** Accumulate one priced request into the fold state. */
function priceInto(
  state: SessionCostState,
  request: PricedRequest,
  versionId: string,
): SessionCostState {
  const model = request.model
  const bucket: ModelCostBucket = state.models[model] ?? emptyModelBucket()
  const dayKey = dayKeyOf(request.billedAt)
  const day: DayCostBucket = state.days[dayKey] ?? emptyDayBucket()
  return {
    ...state,
    pricedRequests: state.pricedRequests + 1,
    totalCost: state.totalCost + request.cost,
    models: {
      ...state.models,
      [model]: {
        requests: bucket.requests + 1,
        cost: bucket.cost + request.cost,
        inputMissTokens: bucket.inputMissTokens + request.missTokens,
        inputHitTokens: bucket.inputHitTokens + request.hitTokens,
        outputTokens: bucket.outputTokens + request.outputTokens,
      },
    },
    days: {
      ...state.days,
      [dayKey]: { requests: day.requests + 1, cost: day.cost + request.cost },
    },
    versions: {
      ...state.versions,
      [versionId]: (state.versions[versionId] ?? 0) + 1,
    },
  }
}

/** The `costStats` unit registered on `ctx.sessionProjections` (exported for the unit spec). */
export const sessionCostProjectionDefinition: ProjectionDefinition<'costStats', SessionCostState> = {
  key: 'costStats',
  schema: sessionCostSchema,
  init,
  apply: (state, event) => {
    switch (event.type) {
      case 'step/start': {
        const open = state.openStep
        // Same-reference no-op on an identical re-emission; a changed start
        // time (a genuinely re-entered step) still updates the billing instant.
        if (open !== null && open.turn === event.data.turn && open.step === event.data.step
          && open.startTime === event.time) return state
        return {
          ...state,
          openStep: { turn: event.data.turn, step: event.data.step, startTime: event.time },
        }
      }
      case 'assistant/message': {
        const usage = billableUsageOf(event.data.usage)
        if (usage === null) return state
        const source = event.data.message.source
        const open = state.openStep
        const billedAt = open !== null && open.turn === event.data.turn && open.step === event.data.step
          ? open.startTime
          : event.time
        const request = priceRequest(source.model, source.provider, billedAt, usage)
        if (request.versionId === null) {
          return { ...state, unpricedRequests: state.unpricedRequests + 1 }
        }
        return priceInto(state, request, request.versionId)
      }
      default:
        return state
    }
  },
  view: state => ({
    pricedRequests: state.pricedRequests,
    unpricedRequests: state.unpricedRequests,
    totalCost: state.totalCost,
    models: state.models,
    days: state.days,
    versions: state.versions,
  }),
  stateVersion: 1,
}
