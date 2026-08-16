/**
 * Self-contained build entry for git installs: pnpm extracts the repo, runs
 * `npm install` in the installed package dir (which installs that package's
 * own devDependencies and then runs this prepare script), and links the built
 * package into the consumer. This script therefore must not assume any
 * workspace-only context: it resolves every tool from the invoking package's
 * own devDependencies (typescript, tsdown, dsh-typert-generator, lightningcss)
 * and builds the face aggregate the same way the monorepo does.
 *
 * The one structural difference from a dev checkout is that npm installs the
 * git package's deps into <package>/node_modules only, while the face
 * aggregates build every workspace project (the vendored typert-protocol, the
 * sibling packages) whose imports resolve by walking up to the repo-root
 * node_modules. For the duration of the build, a symlink bridges the repo root
 * to the invoking package's node_modules; it is removed afterwards so nothing
 * of it leaks into the installed store copy. In a dev workspace the root
 * node_modules already exists and no bridge is created.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, symlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const packageDir = process.cwd()
const root = resolve(packageDir, '..', '..') // repo root: the monorepo checkout or the git extraction
const invoking = basename(packageDir)
const face = invoking === 'ui-session-cost' ? 'client' : 'host'
const project = face === 'client' ? 'tsconfig.client.json' : 'tsconfig.host.json'

const run = (args) => {
  const result = spawnSync(args[0], args.slice(1), { cwd: root, stdio: 'inherit', shell: false })
  if (result.error !== undefined) {
    console.error(`prepare: failed to spawn ${args.join(' ')}: ${String(result.error.message ?? result.error)}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

let bridge = null
if (!existsSync(join(root, 'node_modules'))) {
  const target = join(packageDir, 'node_modules')
  if (!existsSync(target)) {
    console.error(`prepare: neither ${join(root, 'node_modules')} nor ${target} exists; cannot resolve build tools`)
    process.exit(1)
  }
  bridge = join(root, 'node_modules')
  symlinkSync(target, bridge, 'dir')
}

try {
  // Both binaries come from the invoking package's own devDependencies: npm
  // puts their .bin on PATH first for git installs; pnpm does the same for
  // workspace installs.
  run(['tsc', '-b', project])
  run(['tsdown', '--env.DSH_BUILD_FACE', face])
} finally {
  if (bridge !== null) {
    try { rmSync(bridge, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
}
