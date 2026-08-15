/** Session-cost browser half: the dock cost strip, the per-session cost view tab, and the usage dashboard. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (composer.dock + conversation.view) and the costStats projection merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-sidebar SlotMap merge (sidebar.footer.action).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// The generated cost Remote contribution, mounted by this plugin (third-party
// remotes self-mount; the first-party api-remotes assembly does not carry them).
import TYPERT_REMOTE from '@logan-luo/dsh-session-cost/remote'
import { CostDockRow } from './CostDockRow.tsx'
import { CostViewTab } from './CostViewTab.tsx'
import { DashboardController } from './controller.ts'
import { DashboardTrigger } from './DashboardTrigger.tsx'
import { en, zh, type CostKey } from './locales.ts'

export type { CostDockRowProps } from './CostDockRow.tsx'
export type { CostViewTabProps } from './CostViewTab.tsx'
export type { CostDashboardTriggerProps } from './slots.ts'
export type { CostKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session-cost surfaces copy. */
    cost: CostKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'cost'

/** Required services: the slot registry, the locale plugin, and the remote carrier. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Client plugin body: the cost strip and view tab reading the costStats
 * projection, plus the sidebar usage trigger over the cost Remote.
 * @param ctx - Client root context.
 * @returns disposer unmounting the self-mounted cost Remote.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-cost: dictionaries')

  // Translate as a thunk, so it follows the active locale without remounting.
  const t = ctx.locale.bind(NS)

  // The dashboard object layer: one controller for the whole surface. The
  // generated contribution is mounted here so the namespace exists before the
  // controller reads it; the returned disposer unmounts with the fiber.
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  const controller = new DashboardController(ctx.remote.cost)
  ctx.effect(() => () => { controller.dispose() }, 'session-cost: dashboard controller')

  // The strip: a second composer.dock row under the built-in stats line.
  // slots.inject waits for ui-conversation's declaration, removes the
  // contribution when it collapses, and reruns after redeclaration.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'cost',
    order: 1,
    locale: NS,
  }, CostDockRow))

  // The breakdown: a conversation view tab next to Chat.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'cost',
    order: 1,
    label: () => t('view.cost'),
    locale: NS,
  }, CostViewTab))

  // The usage dashboard: a sidebar footer action opening the dialog.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'cost-dashboard',
    order: 10,
    locale: NS,
    inject: (): import('./slots.ts').CostDashboardInjected => ({
      hooks: { costDashboard: controller },
      refresh: () => controller.refresh(),
      setSelection: (partial) => { controller.setSelection(partial) },
    }),
  }, DashboardTrigger))

  return async () => { await unmount() }
}
