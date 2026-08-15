// @vitest-environment jsdom
/** Dashboard content: renders totals, model rows, group rows under the active grouping, and the empty note. */

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { Dashboard, groupLabel } from '../src/client/Dashboard.tsx'
import { formatCompact } from '../src/client/labels.ts'
import type { CostDashboardValue } from '@logan-luo/dsh-session-cost/types'
import type { CostKey } from '../src/client/locales.ts'
import { en } from '../src/client/locales.ts'

/** Plain stub translate bound to the English dictionary. */
const t = ((key: CostKey, params?: Record<string, string | number>): string => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}) as Translate<CostKey>

const VALUE: CostDashboardValue = {
  pricedRequests: 2,
  unpricedRequests: 1,
  totalCost: 7.27,
  models: {
    'deepseek-v4-flash': { requests: 1, cost: 4.85, inputMissTokens: 1_000_000, inputHitTokens: 500_000, outputTokens: 200_000 },
    'deepseek-v4-pro': { requests: 1, cost: 2.42, inputMissTokens: 100_000, inputHitTokens: 0, outputTokens: 50_000 },
  },
  groups: {
    '2026-08-16': { requests: 1, cost: 1.41 },
    '2026-08-17': { requests: 1, cost: 4.85 },
  },
  versions: {},
  projects: ['/proj-a'],
}

describe('Dashboard', () => {
  it('renders totals, model rows, and day groups', () => {
    const { container } = render(<Dashboard value={VALUE} groupBy="day" t={t} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Total')
    expect(text).toContain('¥7.27')
    expect(text).toContain('Priced requests2')
    expect(text).toContain('Unpriced requests1')
    expect(text).toContain('Flash')
    expect(text).toContain('Pro')
    expect(text).toContain('08/16')
    expect(text).toContain('08/17')
  })

  it('labels model and project groups through their seats', () => {
    expect(groupLabel('deepseek-v4-flash', 'model')).toBe('Flash')
    expect(groupLabel('2026-08-17', 'week')).toBe('08/17')
    expect(groupLabel('/proj-a', 'project')).toBe('/proj-a')
  })

  it('shows the empty note for an empty selection', () => {
    const { container } = render(<Dashboard value={{
      pricedRequests: 0, unpricedRequests: 0, totalCost: 0, models: {}, groups: {}, versions: {}, projects: [],
    }} groupBy="day" t={t} />)
    expect(container.textContent).toContain('No billable requests')
  })
})

describe('formatCompact', () => {
  it('keeps the stats-strip scale', () => {
    expect(formatCompact(517)).toBe('517')
    expect(formatCompact(12_200)).toBe('12.2K')
    expect(formatCompact(517_000)).toBe('517K')
    expect(formatCompact(1_200_000)).toBe('1.2M')
  })
})
