/** Package invariant companion for `@logan-luo/dsh-session-cost`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@logan-luo/dsh-session-cost'

export const name = 'session-cost-invariant'
export const inject = ['invariants']

/** No runtime invariant: the costStats fold and ledger reconcile are replay-deterministic; the priced-row relation is pinned by specs. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Host context carrying the invariant registry.
 * @returns the registration disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
