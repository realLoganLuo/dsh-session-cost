# @deepseek-ai/dsh-client-ui-session-cost

[English](README.md) | 中文

会话成本界面，浏览器半：dock 成本条、每会话成本视图标签页，以及用量看板。计价、投影与账本位于 [@deepseek-ai/dsh-session-cost](../session-cost/README.md)。

## 已交付的界面

- **Dock 成本条**（`src/client/CostDockRow.tsx`）：内置统计条下方的第二个 `conversation.composer.dock` 行——估算费用、主导模型的当前费率，以及未计价数量。读取 `useProjection('costStats')`。
- **成本视图标签页**（`src/client/CostViewTab.tsx`）：`conversation.view` 标签页，含总计、按模型行、按日趋势，以及产生这些数字的费率版本。
- **用量看板**（`src/client/DashboardTrigger.tsx`）：`sidebar.footer.action` 条目，打开全局用量对话框——项目 / 时间段（今天、本周、本月、全部）/ 分组（日、周、月、模型、项目）选择，基于 `cost.dashboard` Remote，含总计、按模型桶与分组。`DashboardController`（`src/client/controller.ts`）持有视图状态与刷新/选择动词。

## 模型体验

无：本包渲染宿主计算的投影值与 Remote 汇总；不组装任何模型请求。

#### KV 缓存影响

无；本包既不组装也不发送任何提供商请求。

## 已知限制与延期工作

- 时间段预设与费率卡共用同一固定北京偏移日历；具名时区仍是与 node 半共享的延期配置项。
- 看板的项目列表是账本中项目的去重集合；磁盘上的项目重命名会把历史拆成两行。
