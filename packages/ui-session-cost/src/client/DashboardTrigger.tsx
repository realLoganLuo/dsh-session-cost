// Dashboard trigger: the sidebar footer action that opens the usage dialog.
// Owns the dialog's open state; the selection and rollup live in the
// controller behind the injected hook.

import { memo, useEffect, useState } from 'react'
import { Dashboard } from './Dashboard.tsx'
import type { DashboardRange } from './controller.ts'
import type { CostDashboardTriggerProps } from './slots.ts'
import type { RollupGroupBy } from '@deepseek-ai/dsh-session-cost/types'
import css from './DashboardTrigger.module.css'

const RANGES: readonly DashboardRange[] = ['today', 'week', 'month', 'all']
const GROUP_BYS: readonly RollupGroupBy[] = ['day', 'week', 'month', 'model', 'project']

export const DashboardTrigger = memo(function DashboardTrigger(props: CostDashboardTriggerProps) {
  const { useCostDashboard, refresh, setSelection, t } = props
  const dashboard = useCostDashboard(view => view)
  const [open, setOpen] = useState(false)
  const value = dashboard.value
  const projects = value?.projects ?? []

  const openDialog = (): void => {
    setOpen(true)
    void refresh()
  }

  // Escape and backdrop clicks close the dialog.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [open])

  return (
    <>
      <button type="button" className={css.trigger} onClick={openDialog}>
        {t('dashboard.trigger')}
      </button>
      {open && (
        <div className={css.overlay} role="dialog" aria-modal="true" aria-label={t('dashboard.title')} onClick={() => { setOpen(false) }}>
          <div className={css.dialog} onClick={(event) => { event.stopPropagation() }}>
            <header className={css.header}>
              <h3 className={css.title}>{t('dashboard.title')}</h3>
              <button type="button" className={css.close} onClick={() => { setOpen(false) }}>
                {t('dashboard.close')}
              </button>
            </header>
            <div className={css.controls}>
              <div className={css.controlGroup} role="group" aria-label={t('dashboard.range.today')}>
                {RANGES.map(range => (
                  <button
                    key={range}
                    type="button"
                    className={dashboard.selection.range === range ? css.active : css.pill}
                    onClick={() => { setSelection({ range }) }}
                  >
                    {t(`dashboard.range.${range}`)}
                  </button>
                ))}
              </div>
              <div className={css.controlGroup} role="group" aria-label={t('dashboard.groups')}>
                {GROUP_BYS.map(groupBy => (
                  <button
                    key={groupBy}
                    type="button"
                    className={dashboard.selection.groupBy === groupBy ? css.active : css.pill}
                    onClick={() => { setSelection({ groupBy }) }}
                  >
                    {t(`dashboard.groupBy.${groupBy}`)}
                  </button>
                ))}
              </div>
              <select
                className={css.select}
                value={dashboard.selection.project ?? ''}
                onChange={(event) => {
                  const project = event.target.value
                  setSelection({ project: project === '' ? null : project })
                }}
              >
                <option value="">{t('dashboard.project.all')}</option>
                {projects.filter(project => project !== '').map(project => (
                  <option key={project} value={project}>{project}</option>
                ))}
              </select>
              <button type="button" className={css.pill} onClick={() => { void refresh() }}>
                {t('dashboard.refresh')}
              </button>
            </div>
            <div className={css.body}>
              {dashboard.status === 'loading' && <div className={css.state}>{t('dashboard.loading')}</div>}
              {dashboard.status === 'error' && <div className={css.state}>{t('dashboard.error')}</div>}
              {dashboard.status === 'ready' && value !== undefined && (
                <Dashboard value={value} groupBy={dashboard.selection.groupBy} t={t} />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
})
