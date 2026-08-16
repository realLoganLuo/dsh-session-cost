/** Client-side label helpers: pure functions over cost/pricing vocabulary. */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { formatYuan } from '@logan-luo/dsh-session-cost/pricing'
import type { DeepSeekPricingModel, PricedSelection } from '@logan-luo/dsh-session-cost/pricing'
import type { ModelCostBucket } from '@logan-luo/dsh-session-cost/types'
import type { CostKey } from './locales.ts'

/** Compact token count, mirroring the stats strip: 517 / 12.2K / 517K / 1.2M. */
export function formatCompact(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Display label for a known official model id. */
export function modelLabel(model: string): string {
  if (model === 'deepseek-v4-flash') return 'Flash'
  if (model === 'deepseek-v4-pro') return 'Pro'
  return model
}

/** Display label for a tariff period selection. */
export function periodLabel(t: Translate<CostKey>, period: PricedSelection['period']): string {
  if (period === 'peak') return t('period.peak')
  if (period === 'standard') return t('period.standard')
  return t('period.current')
}

/**
 * Human label for a rate-card version id. Known ids carry their effective
 * date; unknown ids render verbatim.
 * @param versionId - the version id recorded on priced rows.
 * @param t - locale seat.
 * @returns the display label.
 */
export function versionLabel(versionId: string, t: Translate<CostKey>): string {
  const date = versionId.match(/(\d{4}-\d{2}-\d{2})$/)?.[1]
  if (date === undefined) return versionId
  const short = date.slice(5).replace('-', '/')
  return versionId.startsWith('deepseek-pre-')
    ? t('version.before', { date: short })
    : t('version.from', { date: short })
}

/**
 * The model driving the row's rate label: the one with the most priced
 * requests (stable on ties).
 * @param models - per-model buckets.
 * @returns the model id, or null with no priced requests.
 */
export function dominantModel(models: Readonly<Record<string, ModelCostBucket>>): string | null {
  let best: string | null = null
  let bestCount = 0
  for (const [model, bucket] of Object.entries(models)) {
    if (bucket.requests > bestCount) {
      best = model
      bestCount = bucket.requests
    }
  }
  return best
}

/** The official model id used by the row's "current rate" label. */
export function pricingModelOf(model: string | null): DeepSeekPricingModel | null {
  return model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro' ? model : null
}

export { formatYuan }
