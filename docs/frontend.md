---
title: 8 · 每个现有接口的字段落在哪
---

# 每个现有接口的字段落在哪

按 launchpad 现有的响应 DTO 逐个对过。**除配对资产余额那一个接口外全部读 MySQL**。「变化」列是前端需要知道的差异，其余字段形状不变。

**所有接口共有的一处变化：数字字符串统一去尾零**（用户 09-20 定）。库里的数量列是 `DECIMAL(36,18)`，读出来恒带 18 位小数，所以响应里的
`BigDecimal` 一律去掉尾部的零再输出：`"1500"` 而不是 `"1500.000000000000000000"`，美元字段也从 `"18.42000000"` 变成 `"18.42"`。
数值不变、仍是纯数字字符串（不会出现科学计数法），按数值解析的前端不受影响；**按固定小数位截字符串的会**。
字段的单位都没变：原来是整枚的还是整枚，原来承诺是最小单位的（`tokenAmountRaw` / `quoteAmountRaw` / `balanceRaw` / `balance` / `totalSupply` / `circulatingSupply`）还是最小单位。

## 逐接口对照

| 接口 | 读哪张表 | 变化 |
|---|---|---|
| `GET /market/tokens/curve` · `/graduated` · `/search` | `launchpad_v2_token`，join 绑定与用户表 | 排序口径一处变化：**`VOLUME` 按累计成交额排，不再按滚动 24h**（用户 09-19 定），参数名不变；市值排序不变；币龄窗口、⌘K 筛选不变。卡片上两个旧字段的来源：`marketSyncedAt` ← 币行 `updated_at`（线二最近一次写回，不再有 CMC 同步时间），`circulatingSupply` ← `total_supply` 镜像（09-15 起流通量恒等于总供应）；DTO 字段名不变，列名按合约改了（`pairAsset` ← `quote_asset_symbol`、`quoteRaised` ← `quote_reserve`、`deployer*` ← `creator_*`） |
| `GET /coin/detail` | `launchpad_v2_token` + `launchpad_v2_coin_price` 最新行 + 绑定 + 用户 | **新增一个字段 `liquidityUsd`**（= `liquidity_quote` × 配对资产现价；原来只有卡片上有，详情没有——只加不改，前端不用动，用户 09-21 定）。其余无变化；不再打开时同步刷；`priceInPair` ← `price_quote` |
| `GET /coin/kline` | M5 `launchpad_v2_trade` 逐笔；H1 / H6 / D1 `launchpad_v2_kline_minute`；ALL `launchpad_v2_kline_hour` | 无。五档窗口与颗粒不变（见下表）；逐笔画的点 `priceUsd` = `price_quote × quote_usd_price`（成交行上两列都有），聚合的点取那一格的收盘；`marketCapUsd` = `priceUsd × total_supply`；`stale` 恒 false；`refresh` 参数保留但不再有作用 |
| `GET /coin/trades` | `launchpad_v2_trade` 按币倒序 | 游标从 CMC 的 lastId 换成 `(block_time, id)` 编码的不透明串，契约不变；`exchange` 由 `venue` 映射（CURVE →「Bonding Curve」，POOL →「Uniswap v4」）；`quoteAsset` ← 币行 `quote_asset_symbol`（名单外为 null）；`tokenAmount` ← `token_amount`、`quoteAmount` ← `quote_amount`（库里就是整枚）、两个 Raw ← 读时还原成最小单位（`× 10^精度`，精确）；`amountUsd` 可为 null；`traderAddress` 池内可为 null；`stale` 恒 false、`fetchedAt` = 响应时刻 |
| `GET /coin/holders` | `launchpad_v2_balance` 按币余额倒序 | **`publicName` 与 `tags` 恒为 null**；`bondingCurve` ← `holder_kind = CURVE`，其余非 USER 行不列；`creator` ← `holder_address = 币行 creator_address`；`pct` = `balance` ÷ `total_supply`；`balance` ← `balance`（库里就是整枚），`balanceRaw` 读时还原成最小单位；`rank` 读时编号；`holderCount` = 币行 `holder_count` − 该币非 USER 且余额 > 0 的行数（最多几行，一次 COUNT） |
| `GET /assets/activity` | `launchpad_v2_trade` 按 trader | 无。链上直连的成交也会出现；`amountUsd` 可为 null。**`priceQuote` ← `avg_price_quote`**（这笔的成交均价，旧表就是这个含义），不是成交后边际价 `price_quote`；`quoteAmountWhole` ← `quote_amount`（库里就是整枚，工单 36 之后没有带 `_whole` 的列）；`tokenAmountRaw` 读时还原成最小单位；`side`、`venue`、`logIndex`、`traderAddress` 同名直取；币名、代号、图从币行补；最新 40 条，不分页（与原来一致） |
| `GET /assets/positions`（新） | `launchpad_v2_position` + `launchpad_v2_balance` + `launchpad_v2_token` | **新接口**。币、数量（余额表）、下单均价、当前价、未实现盈亏 % 与金额（币本位与 USD）、累计买卖、已实现盈亏；~~持有市值低于粉尘阈值的行不列~~（用户 09-21 定：粉尘过滤先不做，余额 > 0 就列） |
| `GET /assets/history`（新） | `launchpad_v2_trade` 卖出行 | **新接口**，字段见下文「已实现盈亏历史」。一行一次卖出：卖出量、所得、当时成本、`pnlQuote` / `pnlUsd` / `pnlPct`、时间、tx |
| `POST /activities` · `GET /activities/{id}` | — | **删除**。前端交易完成后不再上报，刷新页面即可 |
| `GET /assets/launches` · `/creator-fee-tokens` | `launchpad_v2_token` 按 deployer | 无 |
| `GET /assets/balances/tokens` | `launchpad_v2_balance` 按 holder，`holder_kind = USER` 且 `balance > 0`（余额由 Java 累加，可能短暂为负，读侧只取大于 0），只留币行里有的币 | 无。`balanceDecimal` ← `balance`（库里就是整枚）、`balance` 字符串读时还原成最小单位；`stage` ← 币行 `status`、`priceUsd` / `marketCapUsd` / `priceChange24h` ← 币行；`valueUsd` 读时算；**每行与顶层 `syncedAt` 都取 `launchpad_v2_indexer_state.processed_block_time`**（余额截至 Envio 处理到的区块，余额表本身不存时间） |
| `GET /assets/balances/quote-tokens` | 不读表，后端查链（[第 2 页](/facts)的例外） | 形状不变。来源从 QuickNode + Blockscout 换成只查链：原生币 `eth_getBalance`，名单内代币 `balanceOf`；30 秒缓存；查不到又没有旧值的那一行余额与 `syncedAt` 为 null；`priceUsd` ← `launchpad_v2_coin_price` 最新行 |
| `GET /analytics/overview` | `launchpad_v2_protocol_day` + `launchpad_v2_token` | 无。`volumeUsd` 不再因为漏拍快照而 null；没配价源的配对资产那部分成交不计入 |
| 币↔叙事绑定 | `launchpad_v2_token_content` | 无。来自发币事件的 `socials.storyFun`：`drama_{id}` 或 `video_{id}`，为空 = 没绑。`website` 不参与绑定，原样存、原样返回 |
| `GET /0x/gasless/*` | — | 无。暂时保留，原样不动 |

## K 线五档的数据源

**「窗口 / 颗粒」说的是画出来的样子，「数据源」说的是从哪张表读，两列别混着读**（09-21 就栽在这上面：M5 的「逐笔」被读成了画法）。

| 档 | 窗口 / 颗粒 | 数据源 |
|---|---|---|
| M5 | 5 分钟 / 5 秒 | `launchpad_v2_trade` 的成交行。5 秒的桶没有表（分钟桶对 5 分钟的窗口太粗），读的时候从成交行现算 |
| H1 | 1 小时 / 1 分钟 | `launchpad_v2_kline_minute` 60 行 |
| H6 | 6 小时 / 5 分钟 | 分钟桶 360 行合并成 72 点 |
| D1 | 1 天 / 15 分钟 | 分钟桶，实际只有成交的分钟才有行 |
| ALL | 自发射起 / 随跨度变，见下表 | 颗粒比一小时细的读分钟桶，其余读 `launchpad_v2_kline_hour`；一年 8,760 行封顶，不建日桶 |

**五档是同一条规则**：窗口里不超过 60 笔成交就**逐笔画**（一笔一个点，`bucketMillis = 0`；先查 61 条来判断），超过 60 笔才按这一档的颗粒**聚合**
（`bucketMillis` = 颗粒）。M5 也一样——成交超过 60 笔时是 60 个 5 秒的点，不是把成交逐笔降采样。与 CMC 时代的行为一致。

ALL 的颗粒沿用 CMC 时代的档位映射（[第 5 页](/java)「档位映射保留」），只补上 1d 一档：

| 发射至今 | ≤ 2 小时 | ≤ 6 小时 | ≤ 1 天 | ≤ 7 天 | ≤ 30 天 | ≤ 90 天 | ≤ 365 天 | 更长 |
|---|---|---|---|---|---|---|---|---|
| 颗粒 | 1 分钟 | 5 分钟 | 15 分钟 | 2 小时 | 12 小时 | 1 天 | 1 周 | 30 天（固定，不按自然月） |
| 读 | 分钟桶 | 分钟桶 | 分钟桶 | 小时桶 | 小时桶 | 小时桶 | 小时桶 | 小时桶 |

前三档不能省：发射台上大多数币不到一天，按 2 小时一个点画，发射三小时的热门币 ALL 这一档只有两个点。

聚合的口径：一格的价 = 这一格里**链上最后一笔**成交之后的价（同一区块里的几笔按日志序号定先后，不按到达顺序），桶档就是桶表的 `close_usd`；
`marketCapUsd = 那一格的 priceUsd × total_supply`；点数超过 60 再走 LTTB 降采样。**桶表只有有成交的周期才有行**，没成交的那一格在响应里补、不落库：
**现在的实现是延续上一格的收盘价**（价格没动 = 没人成交；窗口头上那几格延续窗口之前最近的一格，这个币此前从没成交过就不补）。
想改成留空交给前端处理，改动只在 `KlineSeries.merge` 一处。

## 已实现盈亏历史：`GET /assets/history`

参数：`chainId`（可选）、`address`（可选，不传 = 登录用户本人，口径同其它资产页接口）、`cursor`（上一页的 `nextCursor`，不传 = 第一页）、
`size`（默认 20，最大 100）。响应 `{ records, size, nextCursor }`，`nextCursor` 为 null = 没有下一页。游标是 `(block_time, id)` 编码的不透明串，
解不开报参数错误，不会悄悄退回第一页。一律整枚、数字是字符串，**没有最小单位的 Raw 字段**（新接口没有这个包袱）。

| 字段 | 含义 |
|---|---|
| `tokenAddress` `name` `symbol` `imageUri` | 哪个币 |
| `quoteAssetSymbol` | 配对资产代号，下面以配对资产计的金额是这个单位；名单外为 null |
| `venue` | `CURVE` / `POOL` |
| `soldQty` | 卖出量 |
| `proceedsQuote` / `proceedsUsd` | 所得：实际收到的配对资产（已扣费）；美元值按成交那一刻的价固化，当时无价为 null |
| `costQuoteReleased` / `costUsdReleased` | 当时成本：卖掉的这些币当初花了多少，按卖出前的移动加权平均价结转 |
| `pnlQuote` / `pnlUsd` | 已实现盈亏 = 所得 − 当时成本；美元口径缺数为 null，不是 0 |
| `pnlPct` | 盈亏百分比（12.71 = +12.71%），按配对资产口径；成本为 0 时为 null |
| `blockTime` `txHash` `logIndex` | 卖出时间（区块时间，毫秒）、交易、日志序号 |
| `traderAddress` | 卖出者地址；本人名下有多个地址时用它区分 |
