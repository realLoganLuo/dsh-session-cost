// @vitest-environment jsdom
/** Cost dock row: renders the estimate, the dominant model's rate, and the unpriced count; nothing without priced requests. */

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { CostDockRow } from '../src/client/CostDockRow.tsx'
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

function projection(overrides: Partial<SessionCostProjection> = {}): SessionCostProjection {
  return {
    pricedRequests: 1,
    unpricedRequests: 0,
    totalCost: 4.85,
    models: { 'deepseek-v4-flash': { requests: 1, cost: 4.85, inputMissTokens: 1_000_000, inputHitTokens: 500_000, outputTokens: 200_000 } },
    days: { '2026-08-17': { requests: 1, cost: 4.85 } },
    versions: { 'deepseek-2026-08-17': 1 },
    ...overrides,
  }
}

describe('CostDockRow', () => {
  it('renders the estimate and the dominant model rate label', () => {
    const { container } = render(<CostDockRow useProjection={useProjection(projection())} t={t} />)
    expect(container.textContent).toContain('Est. ¥4.85')
    expect(container.textContent).toContain('Flash')
  })

  it('appends the unpriced count when requests fell outside the official card', () => {
    const { container } = render(
      <CostDockRow useProjection={useProjection(projection({ unpricedRequests: 2 }))} t={t} />,
    )
    expect(container.textContent).toContain('2 unpriced')
  })

  it('renders nothing without priced requests', () => {
    const { container } = render(
      <CostDockRow useProjection={useProjection(projection({ pricedRequests: 0, totalCost: 0, models: {} }))} t={t} />,
    )
    expect(container.textContent).toBe('')
  })

  it('renders nothing before the projection value exists', () => {
    const { container } = render(<CostDockRow useProjection={useProjection(undefined)} t={t} />)
    expect(container.textContent).toBe('')
  })
})
