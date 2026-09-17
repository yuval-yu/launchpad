---
title: 5 · 拷一张币表、四条定时线、读接口直查 Envio
---

# 拷一张币表、四条定时线、读接口直查 Envio

Java 不再逐表同步。**只把 `Token` 实体拷进 `launchpad_token`**，而且只为市场列表：它要按美元排序、要 join 平台表、要搜昵称； **四条定时线**算口径和现价类 USD；**其余读接口请求来了直接查 Envio 的 GraphQL**，USD 已经在实体里。

## Token 同步：唯一的拷贝

- **按 `updatedAtBlock` 增量。** 每 2 秒 `Token(where: {updatedAtBlock: {_gte: $last}}, order_by: {updatedAtBlock: asc})`，整行覆盖 `launchpad_token` 的链上列与累加列，口径列不动。游标落 `launchpad_sync_cursor`
- **自愈。** 若发生回滚，Envio 恢复的旧版本 `updatedAtBlock` 更小，增量会漏。每小时把「24h 内有成交的币」全量重拷一遍，集合有限，一次请求
- **按币重跑。** 指定 token，重拷它并重算口径列。修数据、改口径、补绑定，都是它
- **单实例。** 多节点只让持 Redis 锁的节点拉，和现在定时任务一样
- **告警。** Envio 已处理区块落后链头超阈值报；Java 游标落后 Envio 超阈值报

**经我们工厂发的币全部收录。** 发行者反查不到平台用户只是 `deployerUser` 为 null，配对资产没配价源只是 USD 为 null。

## 四条定时线

| 线 | 输入 | 按口径算 | 写 | 频率 |
|---|---|---|---|---|
| **一 · 定价** | 外部价源：币安 / Robinhood 股票 API | 各配对资产的现价，落成历史（分钟行 + 小时行）。**Envio 的取价 Effect 读的就是这张表**。详见[第 6 页](/pricing) | launchpad_coin_price（+ Redis 副本，可选） | 每分钟 |
| **二 · 币视图** | `launchpad_token` 链上列；按需查 Envio 的 `Balance` | 新币：叙事绑定、OG、发行者用户、配对资产的代号与价源。全表：现价、市值、流动性、持有人数、发行者持仓占比 | launchpad_token 口径列 / launchpad_token_content | 每分钟 |
| **三 · 行情窗口** | Envio 的小时桶 + 首尾两小时的分钟桶，只拉窗口内有成交的 | 严格滚动 24h 成交额（桶里 `volumeUsdCurve` + `volumeUsdPool` 求和）、24h 涨跌 | launchpad_token 两列 | 每 5 分钟 |
| **四 · 协议日** | Envio 的 `ProtocolDay` 90 天 + `launchpad_token` | 昨天 / 前天 / 90 天趋势；发射数与去重发射者按 UTC 日读时数 | 响应缓存 60 秒 | 读时 + 缓存 |

线三和线四也可以不走 GraphQL：自建的 Postgres 给 Java 一个只读账号，在实体表上直接跑 `GROUP BY`，一条 SQL 出全部币的 24h 量。实体表结构由 Envio 生成，只读不写，schema 变了要跟着改，这是唯一的耦合。

#### 线二 · 币视图

对**新出现的币**，做的正是现在 Kafka handler 做的：

- **发行者用户**：`deployer` 经 `user_wallet_address` 反查，查到就存 `deployer_user_id`，查不到留空；用户后来绑了钱包，下一轮补上
- **配对资产**：精度来自链上注册表（`QuoteAssetConfig`），代号来自 Envio 读的 `symbol()` 或运营名单；在运营名单里配了价源的资产才有 USD，没配的 USD 为 null 并告警，**币照样收录、金额照样按配对资产显示**
- **叙事绑定**：解析 `socials.storyFun`（合约里专门给 Story.Fun 的字段）的路径 `/drama/{id}` 或 `/video/{id}`，为空再看 `website`；内容存在 → `launchpad_token_content`，绑不上照收不绑
- **OG**：同名同代号里 `launched_at` 最早的那个，`og_key` 现算法不变

对**全表**，每轮算这些：

- **状态**：`curve_closed_at` 非空即 GRADUATED，`graduated_at` 取它
- **毕业进度**：`quote_raised = net_quote_raised`
- **价格与市值**：`price_usd = last_price_quote × 配对资产现价`；`market_cap_usd = price_usd × total_supply`。**一条 UPDATE SQL**，配对资产价一动全表跟着动，市值排序永远基于最新价
- **流动性 `liquidity_usd`**：曲线阶段 = `net_quote_raised × 配对资产现价`；毕业后从 `pool_liquidity` 与 sqrtPrice 换算两边储备折美元
- **持有人数 / 发行者持仓占比**：`positive_balance_count` 减去 curve、PoolManager、锁仓合约中余额为正的个数；`deployer_holding_pct` = deployer 的 `Balance` ÷ 总供应。这两项要查 Envio，按「有成交的币」批量查，一轮一两次请求

#### 线三 · 行情窗口

口径是**严格滚动 24 小时**。窗口内完整的小时桶加首尾两个不完整小时的分钟桶，按币把 `volumeUsdCurve` 与 `volumeUsdPool` 求和； 「含 DEX」的选择就是加不加后一列，只在这一行代码里。 涨跌的基准价是窗口内第一个桶的 `open`；币龄不足 24h 用首笔成交价。没成交的币算出 0，库里非 0 的置 0。

#### 线四 · 协议日

`ProtocolDay` 的 `volumeUsdCurve` / `volumeUsdPool` 已经是按成交时点固化的美元量，读时直接按天取、按口径相加；发射数与去重发射者仍从 `launchpad_token` 按 UTC 日读时算。 All-time 成交额 = 日表求和 + 今天的实时量。

## 读接口：查哪里、补什么

| 能力 | 查哪里 | 现场加工 |
|---|---|---|
| 市场列表 / 搜索 / 分区 | **MySQL** `launchpad_token` 一条 SQL | 已在表里算好，join 绑定与用户表。索引不动。**这是唯一读拷贝表的接口** |
| 币详情 | **Envio** `Token` 一行 + 该币最近 24h 的 `CandleHour` / 首尾 `CandleMinute`；**MySQL** 只取配对资产现价、叙事、发行者用户 | `priceUsd = lastPriceQuote × 配对资产现价`，`marketCapUsd = priceUsd × totalSupply`，`priceInPair = lastPriceQuote`，`volumeUsd24h` 现场从桶求和，曲线进度 = `netQuoteRaised ÷ graduationThreshold`，流动性同线二公式。与列表卡片同一套公式，列表算好存着、详情现算，数字一致 |
| K 线五档 | **Envio**：M5 查 `Trade` 逐笔；H1 / H6 / D1 查 `CandleMinute`；ALL 按跨度查分钟桶、小时桶或日桶再合并到 2h / 12h / 1w / 1M | 「不超过 60 笔逐笔画」先查 61 条；补空档；`marketCapUsd = closeUsd × totalSupply`。**USD 已在实体里，不再合并价格** |
| 成交记录页签 | **Envio** `Trade(where: {token, id: {_lt: cursor}}, order_by: {id: desc}, limit: 10)` | 方向直接读 `side`；`exchange` 给「曲线」或「Uniswap v4」；`nextCursor` = 最后一行 id，前端契约不变 |
| 持有人榜 + 人数 | **Envio** `Balance` 按币、余额倒序，前 100 + 若干 | 剔除 PoolManager / 锁仓合约，CURVE 阶段保留曲线行并标 `bondingCurve`，算占比、标 Creator。**`publicName` 与 `tags` 恒为 null** |
| Activity | **Envio** `Trade(where: {trader: {_eq: addr}})`，登录用户名下多个地址用 `_in` | 补币名与图（读 `launchpad_token`）。`launchpad_activity` 表、上报接口 `POST /activities` 与轮询 `GET /activities/{id}` 删除 |
| 持仓页（新） | **Envio** `Position` 按 trader；每行再取 `Balance` 与 `Token.lastPriceQuote` | 数量 = `Balance`；均价 = `avgCostQuote`；未实现盈亏 % = `lastPriceQuote ÷ avgCostQuote − 1`；未实现金额 = `(lastPriceQuote − avgCostQuote) × 数量`，乘配对资产现价得 USD；持有市值低于粉尘阈值的行不列（读时口径） |
| 历史持仓（新） | **Envio** `Trade` 按 trader，只取卖出行，时间倒序 | 一行一次卖出：卖了多少、所得、当时成本、`pnlQuote` / `pnlUsd` / `pnlPct` 直接读；要按币合并成一次进出就读时按 token 分组，或直接展示 `Position` 的累计值 |
| 平台币余额 | **Envio** `Balance` 按 account，`token` 非空 | 只留 `launchpad_token` 里有的币，即经我们工厂发的；补名字、图标、价格与市值 |
| 配对资产余额 | **RPC**：原生 ETH `eth_getBalance`，其余按运营名单逐个 `balanceOf`，链上有 Multicall 就合成一次调用 | 按名单顺序、0 也返回，补 `launchpad_coin_price` 最新价；30 秒缓存、失败给旧值、都没有就该行 `syncedAt = null`，与现在两份快照的降级规则一致。Blockscout 客户端删除，QuickNode 客户端保留 |
| 协议数据页 | **Envio** `ProtocolDay` + **MySQL** `launchpad_token` | 线四 |

::: tip 读时直查的两条守则
**每一样前面放 Redis 短缓存，TTL 几秒**，只用来合并并发请求；Envio 抖动时缓存期内不受影响，缓存也没有就返回空并标 `stale`，不 5xx。

**只查 Hasura，不在读路径直连 Postgres。** 只读账号只给线三、线四那种批量聚合用；读路径走 GraphQL 保证 Envio 升级时接口契约稳定。
:::
