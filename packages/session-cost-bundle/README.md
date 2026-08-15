# @deepseek-ai/dsh-session-cost-bundle

English | [中文](README.zh.md)

Installable bundle for session cost: mounts the [dsh-session-cost](../../session/session-cost/README.md) ledger service and the [dsh-client-ui-session-cost](../../client/ui-session-cost/README.md) surfaces over any dsh profile whose base already provides storage, session persistence, and session-query (dsh-base does).

## Install

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-session-cost-bundle
```

The bundle's patch inserts two rows: `session-cost` (the node service) and `ui-session-cost` (the browser surfaces). The shipped web profile already composes these rows, so **do not install the bundle over a web-app-based profile**: the duplicate ids make the Loader reject the composed config. Install it into a profile that does not already mount the rows (a headless or custom profile) to enable the feature.

## What you get

- The `costStats` projection and the `cost.dashboard` Remote rollups (per project / time range / model / day-week-month grouping).
- The dock cost strip, the per-session cost view tab, and the sidebar usage dashboard.

## Model Experience

None: the bundle composes plugins that only observe session usage and provenance; no model request is assembled or sent.

#### KV Cache effect

None.
