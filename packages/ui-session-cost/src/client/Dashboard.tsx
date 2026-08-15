// Dashboard dialog content: the global usage surface over the cost Remote.
// Renders the rollup — totals, per-model buckets, and the requested groups —
// as a pure function of the value and the active grouping.

import { memo, useMemo } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { CostDashboardValue, RollupGroupBy } from '@logan-luo/dsh-session-cost/types'
import type { CostKey } from './locales.ts'
import { formatCompact, formatYuan, modelLabel } from './labels.ts'
import css from './Dashboard.module.css'

/** Props: the rollup value, the active grouping, and the locale seat. */
export interface DashboardProps {
  value: CostDashboardValue
  groupBy: RollupGroupBy
  t: Translate<CostKey>
}


/** Group key display: dates as MM/DD, model ids through the label seat, projects verbatim. */
export function groupLabel(key: string, groupBy: RollupGroupBy): string {
  if (groupBy === 'model') return modelLabel(key)
  if (groupBy === 'day' || groupBy === 'week') return key.slice(5).replace('-', '/')
  return key
}

export const Dashboard = memo(function Dashboard({ value, groupBy, t }: DashboardProps) {
  const modelRows = useMemo(
    () => Object.entries(value.models).sort((left, right) => right[1].cost - left[1].cost),
    [value.models],
  )
  const groupRows = useMemo(
    () => Object.entries(value.groups).sort((left, right) => left[0].localeCompare(right[0])),
    [value.groups],
  )
  if (value.pricedRequests === 0 && value.unpricedRequests === 0) {
    return <div className={css.empty}>{t('dashboard.empty')}</div>
  }
  return (
    <div className={css.root}>
      <dl className={css.totals}>
        <div>
          <dt>{t('tab.total')}</dt>
          <dd>¥{formatYuan(value.totalCost)}</dd>
        </div>
        <div>
          <dt>{t('tab.pricedRequests')}</dt>
          <dd>{value.pricedRequests}</dd>
        </div>
        <div>
          <dt>{t('tab.unpricedRequests')}</dt>
          <dd>{value.unpricedRequests}</dd>
        </div>
      </dl>
      <h4 className={css.section}>{t('tab.models')}</h4>
      <table className={css.table}>
        <tbody>
          {modelRows.map(([model, bucket]) => (
            <tr key={model}>
              <td className={css.model}>{modelLabel(model)}</td>
              <td className={css.num}>{t('tab.requests')} {bucket.requests}</td>
              <td className={css.tokens}>
                {t('tab.tokens', {
                  miss: formatCompact(bucket.inputMissTokens),
                  hit: formatCompact(bucket.inputHitTokens),
                  output: formatCompact(bucket.outputTokens),
                })}
              </td>
              <td className={css.cost}>¥{formatYuan(bucket.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4 className={css.section}>{t('dashboard.groups')}</h4>
      <table className={css.table}>
        <tbody>
          {groupRows.map(([key, bucket]) => (
            <tr key={key}>
              <td className={css.model}>{groupLabel(key, groupBy)}</td>
              <td className={css.num}>{bucket.requests} {t('tab.requests')}</td>
              <td className={css.cost}>¥{formatYuan(bucket.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
})
