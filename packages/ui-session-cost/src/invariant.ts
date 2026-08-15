/** Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-session-cost`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-session-cost'

/** Cordis companion plugin name. */
export const name = 'client-ui-session-cost-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the plugin owns three slot registrations and one
 * dashboard controller, all released by the same effect disposers. The
 * lifecycle spec proves every registration is withdrawn and the controller
 * dropped when the owning fiber is disposed, so no second authority exists to
 * check at runtime.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
