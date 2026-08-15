/**
 * Self-contained build entry for git installs: pnpm runs the installed
 * package's `prepare` after checkout, and this script builds the workspace
 * aggregate for the invoking package's face (host for the node half and the
 * bundle, client for the surface package), including the Typert generation
 * that emits the /typert and /remote artifacts.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { basename, dirname } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageDir = dirname(dirname(fileURLToPath(import.meta.url))) // scripts/.. == repo root
const invoking = basename(process.cwd())
const face = invoking === 'ui-session-cost' ? 'client' : 'host'
const project = face === 'client' ? 'tsconfig.client.json' : 'tsconfig.host.json'

const run = (args) => {
  const result = spawnSync('pnpm', ['exec', ...args], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

void packageDir
run(['tsc', '-b', project])
run(['tsdown', '--env.DSH_BUILD_FACE', face])
