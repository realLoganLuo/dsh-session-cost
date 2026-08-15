# @logan-luo/dsh-session-cost

[English](README.md) | 中文

会话成本核算，node 半：版本化费率卡引擎、每会话 `costStats` 投影，以及 `cost` Remote 命名空间背后的持久化账本。界面（dock 成本条、成本视图标签页、用量看板）位于 [@logan-luo/dsh-client-ui-session-cost](../ui-session-cost/README.md)。

## 已交付的界面

- **费率卡引擎**（[`src/pricing.ts`](src/pricing.ts)）：带生效日期边界与北京高峰窗口的版本化官方 DeepSeek 人民币定价；纯函数，与浏览器半共享。
- **`costStats` 投影单元**（[`src/projection.ts`](src/projection.ts)）：对每个带用量的 `assistant/message`，按其模型、计费时刻（打开中的 step 的开始时刻）与当时生效的费率卡版本计价；折叠出按模型、按日、按费率版本的桶。注册在 `ctx.sessionProjections` 上，因此值通过标准会话投影通道（`useProjection('costStats')`）到达浏览器。
- **账本服务**（[`src/index.ts`](src/index.ts)，`SessionCostService extends TypertRemoteService`）：基于 `ctx.sessionQuery` 语料库对账——将每个会话的日志折叠越过其扫描水位、修剪已删除会话、隔离不可读日志——并通过生成的 `cost.dashboard` Remote 提供看板汇总。行持久化在 `session_cost` 存储域中。
- **汇总**（[`src/ledger.ts`](src/ledger.ts)）：纯折叠与聚合——按模型、按日/周/月（北京日历）、按项目，带计费时刻边界。

没有官方费率卡的模型的请求计为未计价，绝不猜测。

## 模型体验

无：本包不组装任何模型请求。投影单元与账本只从会话事件流和持久化日志观察 `assistant/message` 的用量与来源。

#### KV 缓存影响

无；本包既不组装也不发送任何提供商请求。

## 已知限制与延期工作

- 费率表硬编码为 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ 公布的官方 DeepSeek 人民币费率卡。未来的 `config` 键可在不改动引擎的情况下接受部署覆盖。
- 高峰窗口按固定北京偏移（`DEEPSEEK_BEIJING_OFFSET_MINUTES`）确定日历；具名时区（`Asia/Shanghai`）仍是延期的配置项。
- 对账会重读每个事件越过其水位的会话日志（带受限的并发读取），每次看板调用都会在内存中物化行表；按日志指纹跳过未改动日志以及索引化汇总，延后到大语料部署需要时再做。
