---
title: 8 · 每个现有接口的字段落在哪
---

# 每个现有接口的字段落在哪

按 launchpad 现有的响应 DTO 逐个对过。**全部读 MySQL**。「变化」列是前端需要知道的差异，其余字段形状不变。

## 逐接口对照

| 接口 | 读哪张表 | 变化 |
|---|---|---|
| `GET /market/tokens/curve` · `/graduated` · `/search` | `launchpad_v2_token`，join 绑定与用户表 | 排序口径一处变化：**`VOLUME` 按累计成交额排，不再按滚动 24h**（用户 09-19 定），参数名不变；市值排序不变；币龄窗口、⌘K 筛选不变。卡片上两个旧字段的来源：`marketSyncedAt` ← 币行 `updated_at`（线二最近一次写回，不再有 CMC 同步时间），`circulatingSupply` ← `total_supply` 镜像（09-15 起流通量恒等于总供应）；DTO 字段名不变，列名按合约改了（`pairAsset` ← `quote_asset_symbol`、`quoteRaised` ← `quote_reserve`、`deployer*` ← `creator_*`） |
| `GET /coin/detail` | `launchpad_v2_token` + `launchpad_v2_coin_price` 最新行 + 绑定 + 用户 | 无。不再打开时同步刷；`liquidityUsd = liquidity_quote × 配对资产价` |
| `GET /coin/kline` | M5 `launchpad_v2_trade` 逐笔；H1 / H6 / D1 `launchpad_v2_kline_minute`；ALL `launchpad_v2_kline_hour` | 无。五档窗口与颗粒不变；`stale` 恒 false |
| `GET /coin/trades` | `launchpad_v2_trade` 按币倒序 | 游标从 CMC 的 lastId 换成 `(block_time, id)` 编码的不透明串，契约不变；`exchange` 给「曲线」或「Uniswap v4」；`amountUsd` 可为 null |
| `GET /coin/holders` | `launchpad_v2_balance` 按币余额倒序 | **`publicName` 与 `tags` 恒为 null**；曲线 / PoolManager 行标 `bondingCurve`；`holderCount` 为剔除合约后的数 |
| `GET /assets/activity` | `launchpad_v2_trade` 按 trader | 无。链上直连的成交也会出现；`amountUsd` 可为 null |
| `GET /assets/positions`（新） | `launchpad_v2_position` + `launchpad_v2_balance` + `launchpad_v2_token` | **新接口**。币、数量（余额表）、下单均价、当前价、未实现盈亏 % 与金额（币本位与 USD）、累计买卖、已实现盈亏；持有市值低于粉尘阈值的行不列 |
| `GET /assets/history`（新） | `launchpad_v2_trade` 卖出行 | **新接口**。一行一次卖出：卖出量、所得、当时成本、`pnlQuote` / `pnlUsd` / `pnlPct`、时间、tx |
| `POST /activities` · `GET /activities/{id}` | — | **删除**。前端交易完成后不再上报，刷新页面即可 |
| `GET /assets/launches` · `/creator-fee-tokens` | `launchpad_v2_token` 按 deployer | 无 |
| `GET /assets/balances/tokens` | `launchpad_v2_balance` 按 holder | 无。`syncedAt` = 最后一条 Transfer 消息的区块时间 |
| `GET /assets/balances/quote-tokens` | — | **下线**（[第 10 页](/rollout) Q1）：前端用钱包 SDK 直接读链 |
| `GET /analytics/overview` | `launchpad_v2_protocol_day` + `launchpad_v2_token` | 无。`volumeUsd` 不再因为漏拍快照而 null；没配价源的配对资产那部分成交不计入 |
| 币↔叙事绑定 | `launchpad_v2_token_content` | 无。来自发币事件 `socials.storyFun` 的路径，为空再看 `website` |
| `GET /0x/gasless/*` | — | **移出 launchpad**（Q2） |

## K 线五档的数据源

| 档 | 窗口 / 颗粒 | 数据源 |
|---|---|---|
| M5 | 5 分钟 / 5 秒 | `launchpad_v2_trade` 逐笔 |
| H1 | 1 小时 / 1 分钟 | `launchpad_v2_kline_minute` 60 行 |
| H6 | 6 小时 / 5 分钟 | 分钟桶 360 行合并成 72 点 |
| D1 | 1 天 / 15 分钟 | 分钟桶，实际只有成交的分钟才有行 |
| ALL | 自发射起 | `launchpad_v2_kline_hour` 按跨度合并成 2h / 12h / 1d / 1w / 1M；一年 8,760 行封顶，不建日桶 |

「不超过 60 笔逐笔画」先查 61 条；`marketCapUsd = close_usd × total_supply`；LTTB 降采样保留。**桶表只有有成交的周期才有行**，没成交的那一格在响应里补（延续上一根收盘价或留空由展示定），不落库。
