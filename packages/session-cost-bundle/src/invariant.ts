/** Package-owned invariant companion for `@logan-luo/dsh-session-cost-bundle`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@logan-luo/dsh-session-cost-bundle'

/** Cordis companion plugin name. */
export const name = 'session-cost-bundle-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the bundle owns no runtime state; its patch mounts
 * the two product plugins, whose own invariants and lifecycle specs cover
 * their registrations.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
