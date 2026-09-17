---
title: 8 · 每个现有接口的字段落在哪
---

# 每个现有接口的字段落在哪

按 launchpad 现有的响应 DTO 逐个对过。规律：**只有列表和搜索读 MySQL，其余读 Envio**，配对资产余额走 RPC。 下表里「变化」列是前端需要知道的差异，其余字段形状不变。

## 逐接口对照

| 接口 | 从哪来 | 变化 |
|---|---|---|
| `GET /market/tokens/curve` · `/graduated` · `/search` | MySQL `launchpad_token` 一条 SQL，join 绑定与用户表 | 无。5 种排序、币龄窗口、⌘K 筛选、索引都不动 |
| `GET /coin/detail` | Envio `Token` + 该币桶；MySQL 取配对资产现价、叙事、发行者用户 | 无。四格现算，与列表卡片同一套公式；`liquidityUsd` 有了自己的来源；不再打开时同步刷 |
| `GET /coin/kline` | Envio `Trade` / `CandleMinute` / `CandleHour` | 无。五档窗口与颗粒不变，ALL 档仍按跨度动态选桶；`stale` 只在 Envio 不可用且缓存过期时为 true |
| `GET /coin/trades` | Envio `Trade` | 无。游标契约不变；`exchange` 值变成「曲线」或「Uniswap v4」 |
| `GET /coin/holders` | Envio `Balance` | **`publicName` 与 `tags` 恒为 null**，那是 CMC 独有的。`holderCount` 改为剔除合约后的数 |
| `GET /assets/activity` | Envio `Trade` 按 `trader` | 无。链上直连的成交也会出现 |
| `GET /assets/positions`（新） | Envio `Position` + `Balance` + `Token` | **新接口**。行字段：币、数量、下单均价（配对资产计）、当前价、未实现盈亏 % 与金额（币本位与 USD 各一份）、累计买入 / 卖出、已实现盈亏 |
| `GET /assets/history`（新） | Envio `Trade` 卖出行 | **新接口**。一行一次卖出：卖出量、所得（配对资产与 USD）、当时成本、盈亏金额与百分比、时间、tx |
| `POST /activities` · `GET /activities/{id}` | — | **删除**。前端交易完成后不再上报，刷新页面即可 |
| `GET /assets/launches` · `/creator-fee-tokens` | MySQL `launchpad_token` 按 deployer | 无 |
| `GET /assets/balances/tokens` | Envio `Balance` | 无。来源从 Blockscout 换成 Envio，`syncedAt` = Envio 已处理区块的时间 |
| `GET /assets/balances/quote-tokens` | RPC：`eth_getBalance` + 名单内各资产 `balanceOf` | 无。来源从 Blockscout 换成直接读链，`syncedAt` = 调用时刻 |
| `GET /analytics/overview` | Envio `ProtocolDay` + MySQL `launchpad_token` | 无。`volumeUsd` 不再因为漏拍快照而 null，只在价格历史缺口时少算缺价的那几笔 |
| 币↔叙事绑定 | MySQL `launchpad_token_content`，线二写 | 无。来自发币事件 `socials.storyFun` 的路径，为空再看 `website`；后补绑定仍走人工 SQL |
| `GET /0x/gasless/*` | — | 不在本文范围 |

## K 线五档的数据源

| 档 | 窗口 / 颗粒 | 数据源 | 为什么 |
|---|---|---|---|
| M5 | 5 分钟 / 5 秒 | **`Trade` 逐笔** | 5 秒桶的行数 ≈ 成交笔数，预聚合零压缩 |
| H1 | 1 小时 / 1 分钟 | `CandleMinute` | 一次 60 行 |
| H6 | 6 小时 / 5 分钟 | `CandleMinute` | 360 行合并成 72 点 |
| D1 | 1 天 / 15 分钟 | `CandleMinute` | 上限 1440 行，实际只有成交的分钟才有行 |
| ALL | 自发射起 / 1 分 ～ 1 月 | ≤ 1 天分钟桶；≤ 30 天 `CandleHour` 合并成 2h / 12h；更长 `CandleDay` 合并成 1w / 1M | 一年也只有 365 行日桶，不用拉八千多行小时桶 |

「不超过 60 笔逐笔画」先查 61 条；没成交的那一格画什么（延续上一根收盘价，还是留空断开）在读时补；`marketCapUsd = closeUsd × totalSupply`。USD 点已在实体里。
