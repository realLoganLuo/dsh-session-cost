# dsh-session-cost

English | [中文](README.zh.md)

Per-session spend tracking for DeepSeek Harness: a versioned official DeepSeek CNY rate card, a live per-session cost projection, a durable reconciled ledger, and browser surfaces (dock cost strip, per-session cost tab, and a usage dashboard grouped by project / time range / model / day-week-month).

Three packages, one installable bundle:

| Package | Face | Role |
| --- | --- | --- |
| [`@logan-luo/dsh-session-cost`](packages/session-cost) | node | Rate-card pricing, `costStats` session projection, `cost` ledger + dashboard Remote |
| [`@logan-luo/dsh-client-ui-session-cost`](packages/ui-session-cost) | browser | Dock strip, cost view tab, dashboard trigger + panel |
| [`@logan-luo/dsh-session-cost-bundle`](packages/session-cost-bundle) | — | dsh profile patch that mounts the other two |

## Prerequisites

`dsh` is the DeepSeek Harness CLI (npm package [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)): profile boot, plugin management, and the browser UI alias. This plugin is a Cordis plugin that runs *inside* a dsh profile — it extends the harness's session tracking and UI, so dsh must be installed and a profile must exist before you can add it.

```sh
npm install -g @deepseek-ai/dsh
dsh --help
```

## Install

```sh
dsh plugin --profile <name> add @logan-luo/dsh-session-cost-bundle
```

`dsh plugin` forwards to pnpm in the profile directory: it installs the bundle and its two dependency packages, and the bundle's patch inserts the `session-cost` (node service) and `ui-session-cost` (browser surfaces) rows. Verify the composed config with:

```sh
dsh --profile <name> --dump-config
```

The bundle targets profiles that do not already mount the rows (a headless or custom profile). The shipped web-app-based profile already composes `session-cost` and `ui-session-cost`, so installing the bundle over it duplicates the rows and the Loader rejects the composed config.

## What you get

- **Pricing**: the official DeepSeek CNY rate card with effective dates and Beijing peak windows (09:00–12:00 and 14:00–18:00). Different periods bill at different rates; the billing instant is the request step start (falling back to the message time), and unpriced requests are counted but excluded from model buckets.
- **Projection**: a live `costStats` session projection on `ctx.sessionProjections`, pushed as `session/projection` frames as requests are priced.
- **Ledger**: a durable `session_cost` storage domain reconciled against `ctx.sessionQuery`; per-session rows are refolded incrementally by sequence watermark, reused session ids are detected via their durable `createdAt`, and stale rows are pruned.
- **Dashboard Remote**: `cost.dashboard` rolls the ledger up by project, time range, model, and day / week / month grouping.
- **UI**: a dock cost strip per conversation, a per-session cost view tab, and a sidebar usage dashboard with a project filter.

## Development

```sh
pnpm install
pnpm run build      # typecheck + bundle both faces (host and client)
pnpm test           # vitest unit tests
pnpm run test:coverage
pnpm run lint       # oxlint
```

Layout notes:

- `packages/typert-protocol` is a vendored source copy of `@deepseek-ai/dsh-typert-protocol`, redirected through tsconfig `paths`; it exists because the typert generator only analyzes `Remote` / `TypertRemoteService` declarations inside a workspace registration.
- The browser packages are built with the `clientBundle`-style closure factory; the client tests drive the apply with hand-faked slots/locale/remote services because the published dsh client packages ship as loader bundles that need the app shell's module table.

## Publishing

The bundle is a Cordis plugin in the standard form: each package carries a `prepare` script (`tsc -b` + tsdown) so git installs work, and `pnpm publish` rewrites the internal `workspace:` deps. Publish per package or via the bundle after `npm login`.

## License

MIT (see each package's `package.json`).
