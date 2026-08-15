// @vitest-environment jsdom
/** Dashboard trigger: opens the usage dialog, renders loading/ready/error states, and forwards selection changes. */

import { describe, expect, it } from 'vitest'
import { useMemo, useSyncExternalStore } from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { DashboardController, type CostDashboardRemote } from '../src/client/controller.ts'
import { DashboardTrigger } from '../src/client/DashboardTrigger.tsx'
import type { CostDashboardTriggerProps } from '../src/client/slots.ts'
import type { CostDashboardValue } from '@logan-luo/dsh-session-cost/types'
import type { CostKey } from '../src/client/locales.ts'
import { en } from '../src/client/locales.ts'

const t = ((key: CostKey, params?: Record<string, string | number>): string => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}) as Translate<CostKey>

const VALUE: CostDashboardValue = {
  pricedRequests: 1,
  unpricedRequests: 0,
  totalCost: 4.85,
  models: { 'deepseek-v4-flash': { requests: 1, cost: 4.85, inputMissTokens: 1_000_000, inputHitTokens: 500_000, outputTokens: 200_000 } },
  groups: { '2026-08-17': { requests: 1, cost: 4.85 } },
  versions: {},
  projects: ['/proj-a'],
}

function remoteOf(overrides: Partial<CostDashboardRemote> = {}): CostDashboardRemote {
  return {
    dashboard: () => Promise.resolve({ ok: true as const, value: VALUE }),
    ...overrides,
  }
}

function Wrapper({ remote }: { remote: CostDashboardRemote }): React.JSX.Element {
  const controller = useMemo(() => new DashboardController(remote), [remote])
  const props = {
    useCostDashboard: (selector: Parameters<CostDashboardTriggerProps['useCostDashboard']>[0]) =>
      useSyncExternalStore(controller.subscribe, () => selector(controller.getSnapshot())),
    refresh: () => controller.refresh(),
    setSelection: (partial: Parameters<CostDashboardTriggerProps['setSelection']>[0]) => {
      controller.setSelection(partial)
    },
    t,
  } as CostDashboardTriggerProps
  return <DashboardTrigger {...props} />
}

describe('DashboardTrigger', () => {
  it('opens the dialog on click and renders the rollup', async () => {
    const { container } = render(<Wrapper remote={remoteOf()} />)
    fireEvent.click(container.querySelector('button')!)
    await waitFor(() => { expect(container.textContent).toContain('Session usage') })
    await waitFor(() => { expect(container.textContent).toContain('¥4.85') })
  })

  it('renders the error state on a failed load', async () => {
    const remote = remoteOf({
      dashboard: () => Promise.resolve({ ok: false as const, error: { code: 'internal' as const, message: 'boom', details: {} } }),
    })
    const { container } = render(<Wrapper remote={remote} />)
    fireEvent.click(container.querySelector('button')!)
    await waitFor(() => { expect(container.textContent).toContain('Failed to load usage data') })
  })

  it('closes the dialog', async () => {
    const { container } = render(<Wrapper remote={remoteOf()} />)
    fireEvent.click(container.querySelector('button')!)
    await waitFor(() => { expect(container.textContent).toContain('Session usage') })
    fireEvent.click(container.querySelectorAll('button')[1]!)
    expect(container.textContent).not.toContain('Session usage')
  })

  it('forwards selection changes through the controller', async () => {
    const calls: Array<Record<string, unknown>> = []
    const remote = remoteOf({
      dashboard: (request) => {
        calls.push(request)
        return Promise.resolve({ ok: true as const, value: VALUE })
      },
    })
    const { container } = render(<Wrapper remote={remote} />)
    fireEvent.click(container.querySelector('button')!)
    await waitFor(() => { expect(container.textContent).toContain('Session usage') })
    const rangeButtons = [...container.querySelectorAll('button')].filter(button => button.textContent === 'Today')
    fireEvent.click(rangeButtons[0]!)
    await waitFor(() => {
      expect(typeof calls[calls.length - 1]?.from).toBe('number')
    })
  })

  it('closes on Escape and on backdrop clicks', async () => {
    const { container } = render(<Wrapper remote={remoteOf()} />)
    fireEvent.click(container.querySelector('button')!)
    await waitFor(() => { expect(container.textContent).toContain('Session usage') })
    // Non-Escape keys keep the dialog open.
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(container.textContent).toContain('Session usage')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.textContent).not.toContain('Session usage')
    // Reopen and close through the backdrop (the dialog itself stops propagation).
    fireEvent.click(container.querySelector('button')!)
    await waitFor(() => { expect(container.textContent).toContain('Session usage') })
    const overlay = document.querySelector('[role="dialog"]')!
    fireEvent.click(overlay)
    expect(container.textContent).not.toContain('Session usage')
  })

  it('forwards grouping, project, and refresh actions', async () => {
    const calls: Array<Record<string, unknown>> = []
    const remote = remoteOf({
      dashboard: (request) => {
        calls.push(request)
        return Promise.resolve({ ok: true as const, value: VALUE })
      },
    })
    const { container } = render(<Wrapper remote={remote} />)
    fireEvent.click(container.querySelector('button')!)
    await waitFor(() => { expect(container.textContent).toContain('Session usage') })
    const groupButtons = [...container.querySelectorAll('button')].filter(button => button.textContent === 'By model')
    fireEvent.click(groupButtons[0]!)
    await waitFor(() => {
      expect(calls[calls.length - 1]?.groupBy).toBe('model')
    })
    const select = container.querySelector('select')!
    fireEvent.change(select, { target: { value: '/proj-a' } })
    await waitFor(() => {
      expect(calls[calls.length - 1]?.project).toBe('/proj-a')
    })
    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() => {
      expect(calls[calls.length - 1]?.project).toBeUndefined()
    })
    const before = calls.length
    const refreshButtons = [...container.querySelectorAll('button')].filter(button => button.textContent === 'Refresh')
    fireEvent.click(refreshButtons[0]!)
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(before)
    })
  })

  it('renders the empty note for an empty selection', async () => {
    const remote = remoteOf({
      dashboard: () => Promise.resolve({ ok: true as const, value: {
        pricedRequests: 0, unpricedRequests: 0, totalCost: 0, models: {}, groups: {}, versions: {}, projects: [],
      } }),
    })
    const { container } = render(<Wrapper remote={remote} />)
    fireEvent.click(container.querySelector('button')!)
    await waitFor(() => { expect(container.textContent).toContain('No billable requests') })
  })
})
