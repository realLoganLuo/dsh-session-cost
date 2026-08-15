# @deepseek-ai/dsh-session-cost-bundle

[English](README.md) | 中文

会话成本可安装组合包：在任何 base 已提供存储、会话持久化与 session-query 的 dsh profile 之上，挂载 [dsh-session-cost](../../session/session-cost/README.md) 账本服务与 [dsh-client-ui-session-cost](../../client/ui-session-cost/README.md) 界面（dsh-base 即满足）。

## 安装

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-session-cost-bundle
```

该组合包的 patch 插入两行：`session-cost`（node 服务）与 `ui-session-cost`（浏览器界面）。随附的 web profile 已组合这两行，因此**不要**在基于 web-app 的 profile 上安装本组合包：重复的 id 会让 Loader 拒绝组合后的配置。请安装到未挂载这些行的 profile（headless 或自定义 profile）以启用该功能。

## 你将获得

- `costStats` 投影与 `cost.dashboard` Remote 汇总（按项目 / 时间段 / 模型 / 日-周-月分组）。
- dock 成本条、每会话成本视图标签页，以及侧边栏用量看板。

## 模型体验

无：该组合包组装的所有插件只观察会话用量与来源；不组装也不发送任何模型请求。

#### KV 缓存影响

无。
