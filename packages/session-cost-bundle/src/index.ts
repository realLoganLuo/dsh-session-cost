/**
 * @deepseek-ai/dsh-session-cost-bundle — the installable session-cost bundle.
 * The bundle patch (`cordis.patch.yml`, declared by the `dsh.bundle.patch`
 * manifest field) mounts the session-cost ledger service and the
 * ui-session-cost surfaces over any profile whose base already provides
 * storage, session persistence, and session-query. The package's own plugin
 * entry is an empty carrier: the bundle is pure composition.
 * @module @deepseek-ai/dsh-session-cost-bundle
 */

/** Stable Cordis plugin name. */
export const name = 'session-cost-bundle'

/** Bundle plugin body — no host-side behavior beyond the patch. */
export function apply(): void {}
