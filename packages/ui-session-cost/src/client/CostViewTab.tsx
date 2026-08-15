// Cost view tab: the per-session breakdown behind the dock row. Renders the
// whole costStats projection — totals, per-model buckets, per-day trend, and
// the rate versions that produced the figures — as a conversation view tab.

import { Fragment, memo, useMemo } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the costStats key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-session-cost/types'
import type { CostKey } from './locales.ts'
import { formatCompact, formatYuan, modelLabel, versionLabel } from './labels.ts'
import css from './CostViewTab.module.css'

/** Props: the projection read seat and the locale seat. */
export interface CostViewTabProps {
  useProjection: UseProjection
  t: Translate<CostKey>
}


export const CostViewTab = memo(function CostViewTab({ useProjection, t }: CostViewTabProps) {
  const cost = useProjection('costStats')
  const dayRows = useMemo(() => {
    if (cost === undefined) return []
    return Object.entries(cost.days)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-14)
  }, [cost])
  if (cost === undefined) return null
  if (cost.pricedRequests === 0 && cost.unpricedRequests === 0) {
    return <div className={css.empty}>{t('tab.empty')}</div>
  }
  const modelRows = Object.entries(cost.models).sort((left, right) => right[1].cost - left[1].cost)
  const versionRows = Object.entries(cost.versions).sort((left, right) => right[1] - left[1])
  return (
    <div className={css.root}>
      <dl className={css.totals}>
        <div>
          <dt>{t('tab.total')}</dt>
          <dd>¥{formatYuan(cost.totalCost)}</dd>
        </div>
        <div>
          <dt>{t('tab.pricedRequests')}</dt>
          <dd>{cost.pricedRequests}</dd>
        </div>
        <div>
          <dt>{t('tab.unpricedRequests')}</dt>
          <dd>{cost.unpricedRequests}</dd>
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
      <h4 className={css.section}>{t('tab.days')}</h4>
      <table className={css.table}>
        <tbody>
          {dayRows.map(([day, bucket]) => (
            <tr key={day}>
              <td className={css.model}>{day.slice(5).replace('-', '/')}</td>
              <td className={css.num}>{bucket.requests} {t('tab.requests')}</td>
              <td className={css.cost}>¥{formatYuan(bucket.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4 className={css.section}>{t('tab.versions')}</h4>
      <ul className={css.versions}>
        {versionRows.map(([versionId, requests]) => (
          <li key={versionId}>
            <Fragment>
              <span>{versionLabel(versionId, t)}</span>
              <span className={css.num}>{requests} {t('tab.requests')}</span>
            </Fragment>
          </li>
        ))}
      </ul>
    </div>
  )
})
