// Cost strip: the second composer.dock row under the built-in stats line.
// Renders the session's official-rate cost estimate from the costStats
// projection, the current rate label of the dominant model, and an unpriced
// count when requests fell outside the official card.

import { memo } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the costStats key into SessionProjectionMap for useProjection.
import type {} from '@logan-luo/dsh-session-cost/types'
import { selectPricing } from '@logan-luo/dsh-session-cost/pricing'
import type { CostKey } from './locales.ts'
import { dominantModel, formatYuan, modelLabel, periodLabel, pricingModelOf } from './labels.ts'
import css from './CostDockRow.module.css'

/** Props: the projection read seat and the locale seat. */
export interface CostDockRowProps {
  useProjection: UseProjection
  t: Translate<CostKey>
}

export const CostDockRow = memo(function CostDockRow({ useProjection, t }: CostDockRowProps) {
  const cost = useProjection('costStats')
  if (cost === undefined || cost.pricedRequests === 0) return null
  const groups: string[] = [t('row.estimate', { cost: formatYuan(cost.totalCost) })]
  const model = pricingModelOf(dominantModel(cost.models))
  // Priced rows always carry an official model, so the fallback never renders.
  /* v8 ignore next 6 -- unreachable: priced rows always carry an official model */
  if (model !== null) {
    const selection = selectPricing(model, Date.now())
    groups.push(t('row.rate', {
      model: modelLabel(model),
      period: periodLabel(t, selection.period),
      rate: formatYuan(selection.rates.inputMiss),
    }))
  }
  if (cost.unpricedRequests > 0) {
    groups.push(t('row.unpriced', { count: cost.unpricedRequests }))
  }
  return <div className={css.root}>{groups.join(' | ')}</div>
})
