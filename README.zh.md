# dsh-session-cost

[English](README.md) | 中文

面向 DeepSeek Harness 的按会话消费统计插件：带生效日期的官方 DeepSeek 人民币费率卡、实时逐会话成本投影、持久化对账账本，以及浏览器界面（dock 成本条、逐会话成本标签页、按项目 / 时间段 / 模型 / 日·周·月分组的用量看板）。

三个包，一个可安装组合包：

| 包 | 端 | 职责 |
| --- | --- | --- |
| [`@logan-luo/dsh-session-cost`](packages/session-cost) | node | 费率卡计价、`costStats` 会话投影、`cost` 账本 + dashboard Remote |
| [`@logan-luo/dsh-client-ui-session-cost`](packages/ui-session-cost) | browser | Dock 成本条、成本视图标签页、看板入口与面板 |
| [`@logan-luo/dsh-session-cost-bundle`](packages/session-cost-bundle) | — | 向 dsh profile 打补丁、挂载上述两行 |

## 前置条件

`dsh` 是 DeepSeek Harness 的命令行（npm 包 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)）：负责 profile 启动、插件管理以及浏览器 UI 别名。本插件是一个运行在 dsh profile **内部** 的 Cordis 插件——它扩展的是 harness 的会话跟踪与界面，因此必须先安装 dsh 并拥有一个 profile，才能添加本插件。

```sh
npm install -g @deepseek-ai/dsh
dsh --help
```

## 安装

**第一步 — 把组合包装进 profile**（安装组合包及其两个依赖包；组合包的补丁会插入 `session-cost` node 服务与 `ui-session-cost` 浏览器界面两行）：

```sh
dsh plugin --profile <name> add @logan-luo/dsh-session-cost-bundle
```

**第二步 — 核对两行是否挂载：**

```sh
dsh --profile <name> --dump-config
```

输出中应能看到 `session-cost` 与 `ui-session-cost` 两行。

**第三步 — 启动 profile 并打开 http://127.0.0.1:3080：**

```sh
dsh --profile <name> web
```

每个会话的输入框下方会显示成本条，Chat 旁边有成本视图标签页；侧边栏底部是用量看板入口（按项目 / 时间段 / 模型 / 日·周·月分组）。

> 组合包面向**尚未挂载这两行的 profile**（headless 或自定义 profile），但其基础需提供平台服务：存储、会话持久化、会话查询，以及 timer 服务（`@deepseek-ai/cordis-plugin-timer`，账本后台对账需要它；`dsh-base` 全部提供）。自带 web-app profile 已组合 `session-cost` 与 `ui-session-cost`，在其上安装组合包会产生重复行，Loader 会拒绝该组合配置。

## 配置

默认值开箱即用，无需任何配置。唯一可调参数是 `session-cost` 行的后台账本对账周期：

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `reconcileIntervalMs` | `5000` | 账本服务每隔这么久（毫秒）在后台把新的会话日志事件折入持久化账本（启动时先跑一轮预热）。看板调用读取最近一次成功对账的账本，本身从不触发扫描；正常新鲜度约为一个周期加一轮扫描耗时。偶发的扫描失败会继续展示旧数据，并在下一个周期自动重试。 |

覆盖它：在 profile 自己的补丁层（`$DSH_HOME/profiles/<name>/cordis.patch.yml`，在所有组合包层之后应用，因此你的行生效）添加**相同 `id`** 的行：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: session-cost
  name: '@logan-luo/dsh-session-cost'
  config:
    reconcileIntervalMs: 10000
```

两点须知：

- 补丁行会**整体替换**目标行的 config，而不是逐键深合并——如果未来版本新增配置项，想保留的键都要重述。
- 配置变更会热重载该行（插件经由 `ctx.effect` 注册的副作用会随卸载/重载自动清理），无需重启。

## 从 GitHub 安装（进阶）

组合包也可以直接从 GitHub 安装；pnpm 会拉取仓库，每个被安装包的 `prepare` 脚本会从源码构建自己的 `lib/`（自包含：只依赖该包自己的 devDependencies，不需要 monorepo 检出环境）：

```sh
dsh plugin --profile <name> add 'github:realLoganLuo/dsh-session-cost#<sha>&path:/packages/session-cost-bundle'
```

两点须知：

- 请锁定 commit（`#<sha>`），防止后续推送悄悄改变实际运行的内容；只对源码可信的包这样做——`prepare` 会在你的机器上、任何沙箱之外执行该包的代码。
- pnpm ≥ 10 在显式允许之前拒绝运行 git 依赖的 `prepare`。第一次 `add` 会失败并打印需要复制到该 profile `pnpm-workspace.yaml` 的确切 `allowBuilds` 键：

  ```yaml
  allowBuilds:
    '@logan-luo/dsh-session-cost-bundle': true
    '@logan-luo/dsh-session-cost': true
    '@logan-luo/dsh-client-ui-session-cost': true
  ```

  然后重新执行 `add`。

组合包的依赖包从 npm 注册表解析，因此 git 安装的组合包应指向版本与已发布 `0.1.0-rc.6` 一致的 commit（或者用各自的 `path:` 说明符从 git 分别安装三个包）。

## 功能一览

- **计价**：带生效日期与北京高峰时段（09:00–12:00 与 14:00–18:00）的官方 DeepSeek 人民币费率卡。不同时段按不同费率计费；计费时点为请求 step 开始（回退到消息时间）；未计价请求会计数但不进入模型分桶。
- **投影**：基于 `ctx.sessionProjections` 的实时 `costStats` 会话投影，随请求计价以 `session/projection` 帧推送。
- **账本**：与 `ctx.sessionQuery` 对账的持久化 `session_cost` 存储域——启动时先跑一轮预热，之后每个 `reconcileIntervalMs` 增量对账一轮；按序列水位增量重折会话行，通过持久化 `createdAt` 识别被复用的会话 id，并清理过期行。
- **Dashboard Remote**：`cost.dashboard` 是纯读操作，把最近一次成功对账的账本按项目、时间段、模型与日 / 周 / 月分组聚合——打开看板或切换筛选从不等待语料扫描。
- **UI**：每个会话的 dock 成本条、逐会话成本视图标签页，以及带项目过滤器的侧边栏用量看板。

## 开发

```sh
pnpm install
pnpm run build      # 类型检查 + 打包双端（host 与 client）
pnpm test           # vitest 单元测试
pnpm run test:coverage
pnpm run lint       # oxlint
```

布局说明：

- `packages/typert-protocol` 是 `@deepseek-ai/dsh-typert-protocol` 的 vendored 源码副本，经 tsconfig `paths` 重定向；它存在是因为 typert 生成器只分析工作区注册内的 `Remote` / `TypertRemoteService` 声明。
- 浏览器包使用 `clientBundle` 风格的闭包工厂构建；客户端测试用手工伪造的 slots/locale/remote 服务驱动 apply，因为已发布的 dsh client 包以 loader bundle 形式分发，需要应用壳的模块表。

## 发布

组合包是标准形式的 Cordis 插件：每个包的 `prepare` 脚本用该包自己的 devDependencies 构建对应端（node 半区与组合包为 host，界面包为 client）——`tsc -b` 加 tsdown，含 Typert 生成——因此 `pnpm publish` 构建与 git 安装都能产出 `lib/`。`npm login` 后按包或经组合包发布。

## 许可

MIT（见各包 `package.json`）。
