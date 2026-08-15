// Shared per-request billing: guarded usage buckets plus the pricing call
// used by both the costStats projection fold and the ledger scan.

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { computeCost, selectPricing } from './pricing.ts'

/** Normalized billable buckets: cache fields default to zero once validated. */
export interface BillableBuckets {
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

/**
 * Provider-reported usage, guarded field by field the way the token meter
 * guards its buckets. Malformed usage is dropped: it is not a billable
 * request and not an unpriced model — it is a data anomaly.
 * @param usage - the assistant/message event's optional usage record.
 * @returns normalized buckets, or null when unreported or invalid.
 */
export function billableUsageOf(usage: unknown): BillableBuckets | null {
  if (typeof usage !== 'object' || usage === null) return null
  const record = usage as Partial<TokenUsage>
  const numberField = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  if (!numberField(record.inputTokens) || !numberField(record.outputTokens)) return null
  return {
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: numberField(record.cacheReadTokens) ? record.cacheReadTokens : 0,
  }
}

/** One priced or unpriced request, exactly as the ledger records it. */
export interface PricedRequest {
  /** Model id of the request (unpriced models included). */
  model: string
  /** Provider route of the request. */
  provider: string
  /** Billing instant (epoch ms). */
  billedAt: number
  /** Total CNY estimate; 0 for unpriced requests. */
  cost: number
  /** Rate-version id that produced the cost, or null when unpriced. */
  versionId: string | null
  /** Tokens used for display. */
  missTokens: number
  hitTokens: number
  outputTokens: number
}

/**
 * Price one usage-bearing request against the official card.
 * @param model - provider model id.
 * @param provider - provider route id.
 * @param billedAt - billing instant (epoch ms).
 * @param usage - normalized buckets.
 * @returns the priced request (unpriced when the model has no official card).
 */
export function priceRequest(
  model: string,
  provider: string,
  billedAt: number,
  usage: BillableBuckets,
): PricedRequest {
  if (provider !== DEEPSEEK_OFFICIAL_PROVIDER
    || (model !== 'deepseek-v4-flash' && model !== 'deepseek-v4-pro')) {
    return {
      model,
      provider,
      billedAt,
      cost: 0,
      versionId: null,
      missTokens: usage.inputTokens,
      hitTokens: usage.cacheReadTokens,
      outputTokens: usage.outputTokens,
    }
  }
  const selection = selectPricing(model, billedAt)
  const cost = computeCost(
    {
      uncachedInputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      outputTokens: usage.outputTokens,
    },
    selection.rates,
  )
  return {
    model,
    provider,
    billedAt,
    cost: cost.total,
    versionId: selection.versionId,
    missTokens: usage.inputTokens,
    hitTokens: usage.cacheReadTokens,
    outputTokens: usage.outputTokens,
  }
}

/** Provider route whose models carry official DeepSeek pricing. */
export const DEEPSEEK_OFFICIAL_PROVIDER = 'deepseek-official'
