# @deepseek-ai/dsh-client-ui-session-cost

English | [中文](README.zh.md)

Session cost surfaces, browser half: the dock cost strip, the per-session cost view tab, and the usage dashboard. The pricing, projection, and ledger live in [@deepseek-ai/dsh-session-cost](../../session/session-cost/README.md).

## Shipped surfaces

- **Dock cost strip** (`src/client/CostDockRow.tsx`): the second `conversation.composer.dock` row under the built-in stats line — estimated cost, the dominant model's current rate, and an unpriced count. Reads `useProjection('costStats')`.
- **Cost view tab** (`src/client/CostViewTab.tsx`): a `conversation.view` tab with totals, per-model rows, per-day trend, and the rate versions that produced the figures.
- **Usage dashboard** (`src/client/DashboardTrigger.tsx`): a `sidebar.footer.action` entry opening the global usage dialog — project / time-range (today, week, month, all) / grouping (day, week, month, model, project) selection over the `cost.dashboard` Remote, with totals, per-model buckets, and groups. The `DashboardController` (`src/client/controller.ts`) owns the view state and the refresh/selection verbs.

## Model Experience

None: the package renders host-computed projection values and Remote rollups; it assembles no model request.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Time-range presets are calendarized in the same fixed Beijing offset as the rate card; a named timezone stays a deferred config option shared with the node half.
- The dashboard's project list is the distinct set of ledger projects; project renames on disk split history into two rows.
