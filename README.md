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

**Step 1 — add the bundle to a profile** (installs the bundle and its two dependency packages; the bundle's patch inserts the `session-cost` node service and the `ui-session-cost` browser surfaces rows):

```sh
dsh plugin --profile <name> add @logan-luo/dsh-session-cost-bundle
```

**Step 2 — verify the rows mounted:**

```sh
dsh --profile <name> --dump-config
```

You should see a `session-cost` row and a `ui-session-cost` row in the dump.

**Step 3 — start the profile and open http://127.0.0.1:3080:**

```sh
dsh --profile <name> web
```

Per conversation you get a cost strip under the composer and a cost view tab next to Chat; the sidebar footer holds the usage dashboard trigger (grouped by project / time range / model / day-week-month).

> The bundle targets profiles that do not already mount the rows (a headless or custom profile) but whose base provides the platform services it needs — storage, session persistence, session-query, and the timer service (`@deepseek-ai/cordis-plugin-timer`, which the ledger's background reconcile requires; `dsh-base` mounts all of them). The shipped web-app-based profile already composes `session-cost` and `ui-session-cost`, so installing the bundle over it duplicates the rows and the Loader rejects the composed config.

## Configuration

The defaults work out of the box — no configuration is required. The only tunable is the background ledger reconcile period on the `session-cost` row:

| Option | Default | Meaning |
| --- | --- | --- |
| `reconcileIntervalMs` | `5000` | How often the ledger service folds new session log events into the durable ledger in the background (a warm-up pass runs at startup). Dashboard calls read the latest successfully reconciled ledger and never trigger a scan themselves; normal freshness is about one period plus one scan. A transient scan failure keeps showing the previous data and retries on the next tick. |

To override it, add a row with the **same `id`** in your profile's own patch layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`, applied after every bundle layer, so your row wins):

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: session-cost
  name: '@logan-luo/dsh-session-cost'
  config:
    reconcileIntervalMs: 10000
```

Two things to know:

- A patch row replaces the target row's **whole** config rather than deep-merging keys — if a future version adds more options, restate every key you want to keep.
- Config changes hot-reload the row (the plugin unloads and reloads through its `ctx.effect` registrations), so no restart is needed.

## Install from GitHub (advanced)

The bundle can also be installed straight from GitHub; pnpm extracts the repo and each installed package's `prepare` script builds its own `lib/` from source (self-contained: only that package's own devDependencies, no workspace checkout required):

```sh
dsh plugin --profile <name> add 'github:realLoganLuo/dsh-session-cost#<sha>&path:/packages/session-cost-bundle'
```

Two things to know:

- Pin a commit (`#<sha>`) so later pushes cannot silently change what runs, and only do this for source you trust — `prepare` executes the package's code on your machine outside any sandbox.
- pnpm ≥ 10 refuses to run the git dependency's `prepare` until you allow it. The first `add` fails and prints the exact `allowBuilds` keys to copy into the profile's `pnpm-workspace.yaml`:

  ```yaml
  allowBuilds:
    '@logan-luo/dsh-session-cost-bundle': true
    '@logan-luo/dsh-session-cost': true
    '@logan-luo/dsh-client-ui-session-cost': true
  ```

  Then re-run `add`.

The bundle's dependency packages resolve from the npm registry, so a git-installed bundle should point at a commit whose versions match the published `0.1.0-rc.6` packages (or install the three packages individually from git with their own `path:` specs).

## What you get

- **Pricing**: the official DeepSeek CNY rate card with effective dates and Beijing peak windows (09:00–12:00 and 14:00–18:00). Different periods bill at different rates; the billing instant is the request step start (falling back to the message time), and unpriced requests are counted but excluded from model buckets.
- **Projection**: a live `costStats` session projection on `ctx.sessionProjections`, pushed as `session/projection` frames as requests are priced.
- **Ledger**: a durable `session_cost` storage domain reconciled against `ctx.sessionQuery` in the background — a warm-up pass at startup, then one incremental pass per `reconcileIntervalMs`; per-session rows are refolded by sequence watermark, reused session ids are detected via their durable `createdAt`, and stale rows are pruned.
- **Dashboard Remote**: `cost.dashboard` is a pure read that rolls the latest reconciled ledger up by project, time range, model, and day / week / month grouping — opening and switching filters never waits for a corpus scan.
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

The bundle is a Cordis plugin in the standard form: each package's `prepare` script builds its face aggregate (host for the node half and the bundle, client for the surface package) with only the package's own devDependencies — `tsc -b` plus tsdown, including the Typert generation — so both `pnpm publish` builds and git installs produce `lib/`. `pnpm publish` publishes per package or via the bundle after `npm login`.

## License

MIT (see each package's `package.json`).
