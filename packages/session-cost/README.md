# @logan-luo/dsh-session-cost

English | [中文](README.zh.md)

Session cost accounting, node half: a versioned rate-card engine, the per-session `costStats` projection, and the durable ledger behind the `cost` Remote namespace. The surfaces (dock cost strip, cost view tab, usage dashboard) live in [@logan-luo/dsh-client-ui-session-cost](../ui-session-cost/README.md).

## Shipped surfaces

- **Rate-card engine** ([`src/pricing.ts`](src/pricing.ts)): versioned official DeepSeek CNY pricing with effective-date boundaries and Beijing peak windows; pure functions shared with the browser half.
- **`costStats` projection unit** ([`src/projection.ts`](src/projection.ts)): prices every usage-bearing `assistant/message` from its model, billing instant (the open step's start), and the rate-card version in force; folds per-model, per-day, and per-rate-version buckets. Registered on `ctx.sessionProjections`, so the value reaches the browser through the standard session-projection feed (`useProjection('costStats')`).
- **Ledger service** ([`src/index.ts`](src/index.ts), `SessionCostService extends TypertRemoteService`): reconciles the ledger over the `ctx.sessionQuery` corpus in the background — a warm-up pass at startup, then one incremental pass per `reconcileIntervalMs` tick (`ctx.interval`, fiber-bound) — folding each session's log past its scan watermark, pruning deleted sessions, and containing unreadable logs. `cost.dashboard` is a pure read over the latest successfully reconciled ledger: opening the dashboard or switching filters never waits on a corpus scan, a failed pass keeps the previous data readable and retries next tick, and concurrent passes never overlap. Rows persist in the `session_cost` storage domain.
- **Rollups** ([`src/ledger.ts`](src/ledger.ts)): pure folds and aggregations — per-model, per-day/week/month (Beijing calendar), per-project, with billing-instant bounds.

Requests whose model has no official card are counted as unpriced rather than guessed.

## Model Experience

None: the package assembles no model request. The projection unit and ledger only observe `assistant/message` usage and provenance from the session event stream and the persisted logs.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The rate table is hardcoded to the official DeepSeek CNY card published at https://api-docs.deepseek.com/zh-cn/quick_start/pricing/. A future `config` key can accept a deployment override without changing the engine.
- Peak windows are calendarized in a fixed Beijing offset (`DEEPSEEK_BEIJING_OFFSET_MINUTES`); a named timezone (`Asia/Shanghai`) stays a deferred config option.
- Reconciliation re-reads every session log whose events grew past its watermark (with bounded read concurrency), and each dashboard call materializes the row table in memory; a per-log fingerprint to skip untouched logs and an indexed rollup are deferred until large-corpus deployments need them. `reconcileIntervalMs` (default 5000) tunes the background reconcile period; the schema floor of 1000 ms guards against accidental high-frequency scans.
- Crash consistency: the startup snapshot serves durable rows covered by a written watermark, which is exactly the last committed ledger. A process killed mid-pass can leave a partially refolded reused-session id (new rows under an old watermark) that becomes visible until the first pass detects the lifecycle change and re-folds it; distinguishing it at startup would require a corpus scan, which the snapshot design deliberately avoids.
- Browser cache: switching back to a cached selection republishes its rollup immediately and revalidates; on a Beijing calendar rollover between the switch and the revalidate the previous period's cached value can show for one render frame before the fresh rollup replaces it.
