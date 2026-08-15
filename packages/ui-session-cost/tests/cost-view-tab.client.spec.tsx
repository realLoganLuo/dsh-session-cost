// @vitest-environment jsdom
/** Cost view tab: renders totals, per-model rows, recent day rows, and rate versions; shows the empty note on a virgin session. */

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { CostViewTab } from '../src/client/CostViewTab.tsx'
import type { SessionCostProjection } from '@deepseek-ai/dsh-session-cost/types'
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

const useProjection = (value: SessionCostProjection | undefined): UseProjection =>
  () => value

function projection(): SessionCostProjection {
  return {
    pricedRequests: 2,
    unpricedRequests: 1,
    totalCost: 7.27,
    models: {
      'deepseek-v4-flash': { requests: 1, cost: 4.85, inputMissTokens: 1_000_000, inputHitTokens: 500_000, outputTokens: 200_000 },
      'deepseek-v4-pro': { requests: 1, cost: 2.42, inputMissTokens: 100_000, inputHitTokens: 0, outputTokens: 50_000 },
    },
    days: {
      '2026-08-16': { requests: 1, cost: 1.41 },
      '2026-08-17': { requests: 1, cost: 4.85 },
    },
    versions: {
      'deepseek-pre-2026-08-17': 1,
      'deepseek-2026-08-17': 1,
    },
  }
}

describe('CostViewTab', () => {
  it('renders totals, model rows, day rows, and rate versions', () => {
    const { container } = render(<CostViewTab useProjection={useProjection(projection())} t={t} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Total')
    expect(text).toContain('¥7.27')
    expect(text).toContain('Priced requests2')
    expect(text).toContain('Unpriced requests1')
    expect(text).toContain('Flash')
    expect(text).toContain('Pro')
    expect(text).toContain('08/16')
    expect(text).toContain('08/17')
    expect(text).toContain('before 08/17')
    expect(text).toContain('from 08/17')
  })

  it('shows the empty note on a session with no billable requests', () => {
    const { container } = render(
      <CostViewTab useProjection={useProjection({
        pricedRequests: 0, unpricedRequests: 0, totalCost: 0, models: {}, days: {}, versions: {},
      })} t={t} />,
    )
    expect(container.textContent).toContain('No billable requests')
  })

  it('renders nothing before the projection value exists', () => {
    const { container } = render(<CostViewTab useProjection={useProjection(undefined)} t={t} />)
    expect(container.textContent).toBe('')
  })
})
