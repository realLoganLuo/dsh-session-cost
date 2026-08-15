/** The dashboard entry's injected face and composed props. */

import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { DashboardView } from './controller.ts'

/** Injected business face of the sidebar dashboard trigger. */
export interface CostDashboardInjected {
  hooks: {
    /** The dashboard view, shared by the trigger and the dialog. */
    costDashboard: HostObservable<DashboardView>
  }
  /** Reload the rollup under the current selection. */
  refresh: () => Promise<void>
  /** Change one selection dimension and reload. */
  setSelection: (partial: Partial<DashboardView['selection']>) => void
}

/** Full props of the sidebar dashboard trigger. */
export type CostDashboardTriggerProps =
  InjectFace<CostDashboardInjected>
  & PropsRenderSlots<never>
  & PropsLocale<'cost'>
