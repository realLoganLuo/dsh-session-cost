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

```sh
dsh plugin --profile <name> add @logan-luo/dsh-session-cost-bundle
```

`dsh plugin` 会在 profile 目录里转发给 pnpm：安装组合包及其两个依赖包，组合包的补丁会插入 `session-cost`（node 服务）与 `ui-session-cost`（浏览器界面）两行。用以下命令核对装配结果：

```sh
dsh --profile <name> --dump-config
```

组合包面向**尚未挂载这两行的 profile**（headless 或自定义 profile）。自带 web-app profile 已组合 `session-cost` 与 `ui-session-cost`，在其上安装组合包会产生重复行，Loader 会拒绝该组合配置。

## 功能一览

- **计价**：带生效日期与北京高峰时段（09:00–12:00 与 14:00–18:00）的官方 DeepSeek 人民币费率卡。不同时段按不同费率计费；计费时点为请求 step 开始（回退到消息时间）；未计价请求会计数但不进入模型分桶。
- **投影**：基于 `ctx.sessionProjections` 的实时 `costStats` 会话投影，随请求计价以 `session/projection` 帧推送。
- **账本**：与 `ctx.sessionQuery` 对账的持久化 `session_cost` 存储域；按序列水位增量重折会话行，通过持久化 `createdAt` 识别被复用的会话 id，并清理过期行。
- **Dashboard Remote**：`cost.dashboard` 按项目、时间段、模型与日 / 周 / 月分组聚合账本。
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

组合包是标准形式的 Cordis 插件：每个包带 `prepare` 脚本（`tsc -b` + tsdown）以支持 git 安装，`pnpm publish` 会重写内部 `workspace:` 依赖。`npm login` 后按包或经组合包发布。

## 许可

MIT（见各包 `package.json`）。
