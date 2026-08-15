/**
 * REAL-composition proof: the shipped YAML shape (session store + JSONL
 * persistence + projection registry + storage hub/domain + session-query +
 * session-cost service) boots through the vendored Loader; a logged usage-
 * bearing request lands in the costStats projection, and the `cost.dashboard`
 * Remote reconciles the persisted corpus into the same rollup.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SessionCostService from '@logan-luo/dsh-session-cost'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<{ ctx: Context; session: Session }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-cost-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: \'@deepseek-ai/dsh-session\'',
    '- id: session-persistence',
    '  name: \'@deepseek-ai/dsh-session-persistence-jsonl\'',
    `  config: { root: ${JSON.stringify(join(root, 'sessions'))} }`,
    '- name: \'@deepseek-ai/dsh-session-projection\'',
    '- name: \'@deepseek-ai/dsh-storage\'',
    '- id: storage-json',
    '  name: \'@deepseek-ai/dsh-storage-json\'',
    `  config: { root: ${JSON.stringify(join(root, 'storage'))} }`,
    '- id: storage-domain',
    '  name: \'@deepseek-ai/dsh-storage-domain\'',
    '  config: { backend: json }',
    '- id: session-query',
    '  name: \'@deepseek-ai/dsh-session-query-sqlite\'',
    '  config: { path: \':memory:\' }',
    '- name: \'@logan-luo/dsh-session-cost\'',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-session-query-sqlite', SessionQuerySqlite],
    ['@logan-luo/dsh-session-cost', SessionCostService],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  const unloaded = [...context.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  const session = context.sessions.create(SessionId('composed'))
  return { ctx: context, session }
}

describe('session-cost through a real Loader composition', () => {
  it('prices a logged request into the projection and the ledger rollup', async () => {
    const { ctx, session } = await loadComposition()
    // Events are wall-clock stamped by Session.append; the rate card in force
    // depends on the current date, so the assertions pin structure, not the
    // tariff.
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
      usage: { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 500_000 },
    }, { surfaceOp: 'append', sourceEventSeqs: [] })

    // The projection sees the request immediately through the registry.
    const projection = ctx.sessionProjections.snapshot(session).values.costStats
    expect(projection?.pricedRequests).toBe(1)
    expect(projection?.totalCost).toBeGreaterThan(0)
    expect(projection?.models['deepseek-v4-flash']?.requests).toBe(1)
    expect(Object.keys(projection?.versions ?? {})).toHaveLength(1)

    // Make the log durable, then reconcile the ledger over the query corpus.
    ctx.emit('session/flush', session)
    const cost = ctx.get('cost') as SessionCostService
    const value = await cost.dashboard({})
    expect(value.pricedRequests).toBe(1)
    expect(value.totalCost).toBeGreaterThan(0)
    expect(value.models['deepseek-v4-flash']?.requests).toBe(1)
    expect(Object.keys(value.groups)).toHaveLength(1)
    expect(Object.keys(value.versions)).toHaveLength(1)
  })
})
