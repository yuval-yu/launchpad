---
title: 8 · 每个现有接口的字段落在哪
---

# 每个现有接口的字段落在哪

按 launchpad 现有的响应 DTO 逐个对过。**全部读 MySQL**。「变化」列是前端需要知道的差异，其余字段形状不变。

## 逐接口对照

| 接口 | 读哪张表 | 变化 |
|---|---|---|
| `GET /market/tokens/curve` · `/graduated` · `/search` | `launchpad_token`，join 绑定与用户表 | 无。5 种排序、币龄窗口、⌘K 筛选不变；DTO 字段名不变，列名按合约改了（`pairAsset` ← `quote_asset_symbol`、`quoteRaised` ← `quote_reserve`、`deployer*` ← `creator_*`） |
| `GET /coin/detail` | `launchpad_token` + `launchpad_coin_price` 最新行 + 绑定 + 用户 | 无。不再打开时同步刷；`liquidityUsd` 有了自己的来源 |
| `GET /coin/kline` | M5 `launchpad_trade` 逐笔；H1 / H6 / D1 `launchpad_kline_minute`；ALL 分钟桶或 `launchpad_kline_day` | 无。五档窗口与颗粒不变；`stale` 恒 false |
| `GET /coin/trades` | `launchpad_trade` 按币倒序 | 游标从 CMC 的 lastId 换成 `(block_time, id)` 编码的不透明串，契约不变；`exchange` 给「曲线」或「Uniswap v4」；`amountUsd` 可为 null |
| `GET /coin/holders` | `launchpad_balance` 按币余额倒序 | **`publicName` 与 `tags` 恒为 null**；曲线 / PoolManager 行标 `bondingCurve`；`holderCount` 为剔除合约后的数 |
| `GET /assets/activity` | `launchpad_trade` 按 trader | 无。链上直连的成交也会出现；`amountUsd` 可为 null |
| `GET /assets/positions`（新） | `launchpad_position` + `launchpad_balance` + `launchpad_token` | **新接口**。币、数量（余额表）、下单均价、当前价、未实现盈亏 % 与金额（币本位与 USD）、累计买卖、已实现盈亏；持有市值低于粉尘阈值的行不列 |
| `GET /assets/history`（新） | `launchpad_trade` 卖出行 | **新接口**。一行一次卖出：卖出量、所得、当时成本、`pnlQuote` / `pnlUsd` / `pnlPct`、时间、tx |
| `POST /activities` · `GET /activities/{id}` | — | **删除**。前端交易完成后不再上报，刷新页面即可 |
| `GET /assets/launches` · `/creator-fee-tokens` | `launchpad_token` 按 deployer | 无 |
| `GET /assets/balances/tokens` | `launchpad_balance` 按 holder | 无。`syncedAt` = 最后一条 Transfer 消息的区块时间 |
| `GET /assets/balances/quote-tokens` | 待定 | 见[第 10 页](/rollout) |
| `GET /analytics/overview` | `launchpad_protocol_day` + `launchpad_token` | 无。`volumeUsd` 不再因为漏拍快照而 null，只在价格历史缺口时少算缺价的那几笔 |
| 币↔叙事绑定 | `launchpad_token_content` | 无。来自发币事件 `socials.storyFun` 的路径，为空再看 `website` |
| `GET /0x/gasless/*` | — | 待定 |

## K 线五档的数据源

| 档 | 窗口 / 颗粒 | 数据源 |
|---|---|---|
| M5 | 5 分钟 / 5 秒 | `launchpad_trade` 逐笔 |
| H1 | 1 小时 / 1 分钟 | `launchpad_kline_minute` 60 行 |
| H6 | 6 小时 / 5 分钟 | 分钟桶 360 行合并成 72 点 |
| D1 | 1 天 / 15 分钟 | 分钟桶，实际只有成交的分钟才有行 |
| ALL | 自发射起 | ≤ 30 天分钟桶合并；更长 `launchpad_kline_day` 合并成 1w / 1M |

「不超过 60 笔逐笔画」先查 61 条；`marketCapUsd = close_usd × total_supply`；LTTB 降采样保留。
