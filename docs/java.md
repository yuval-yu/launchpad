---
title: 5 · Java 改造点：消费、投影、派生、读接口
---

# Java 改造点：消费、投影、派生、读接口

现有的「Kafka → 解析 → 审计表 → `ChainEventProjector` → handler」管线的**代码骨架**保留（监听、审计、按事件名分发、独立事务、状态回写、重投、回放），其余按新方案重写：一条 topic、按 `eventName` 路由、十个新 handler；旧 handler、旧表、`launch_source` 概念整体删除，不留兼容。改动集中在四处：消费管线的吞吐与可靠性、handler 与派生表、定时线、读接口换表。删除的东西在最后一节。

## 改什么，一览

| 模块 | 处置 | 说明 |
|---|---|---|
| `mq/consumer` · `service/chain` 分发 | **改** | 监听 `launchpad.chain.event`；`ChainEventParser` 校验新信封（`txFrom` / `derived`）；registry 只按 `eventName` 路由，`LaunchSource` 删除；批量消费 + 分区并行；死信 topic |
| `service/chain/pons/*` | **删** | 旧 handler 六个、`PonsArgs`、平台归属判定、`PairedAssetResolver`、负向表 |
| `service/chain/handler/*` | **新** | 十种事件的 handler，见下 |
| `service/activity/*` · `controller/ActivityController` · `job/ActivityResolveJob` · `chain/decode/*` | **删** | 前端上报整条链路；`ActivityWriter` 的两来源合并退化成 insertIfAbsent |
| `cmc/*` · `market/source/*` · `service/market/MarketRefreshService` / `Trigger` · `job/MarketSweepJob` / `CmcQuotaMonitor` | **删** | CMC 全部 |
| `chain/ChainRpcClient` · `RpcContractProbe` · web3j 依赖 | **删** | Java 不再调 RPC |
| `explorer/*` · `service/assets/BalanceSnapshotService` | **删** | Blockscout |
| `price/CmcDexPriceSource` → `price/PriceSource` 接口 + 实现 | **换** | 按资产路由；`CoinPriceService` 加 `priceAt` |
| `service/market/KlineService` · `MarketFeedService` · `TokenDetailService` · `service/assets/*` · `AnalyticsService` | **改** | 改读自家表，接口形状不变 |
| `job/*` 定时线 | **改** | 线一定价（有）、线二币视图（新）、线三滚动窗口（新） |
| `controller/internal/*` | **改** | 回放加按币、按事件、全量重建；死信回灌 |
| `zeroex/*` | 待定 | 见[第 10 页](/rollout) |

## 消费管线

**监听与解析。** `@KafkaListener(topics = "launchpad.chain.event")`；`ChainEventMessage` / `ChainEventParser` 按[第 4 页](/messages)的信封写，只校验信封，`derived` 与 `args` 一样交给 handler。审计表唯一键只剩 `event_id`。

**不做入库前过滤。** 工厂发的全收，没有「是不是我们的币」的判断。乱序（成交先于发币到达）不丢：handler 抛可重试异常 → FAILED → `ChainEventRetryJob` 一分钟后重投。

**批量消费 + 分区并行。** `listener.type: batch`，一次 poll 100～500 条：一条 `INSERT IGNORE … VALUES (…),(…)` 落审计，再按 `(blockNumber, logIndex)` 逐条投影，整批 ack；`listener.concurrency` = 分区数。投影仍逐条独立事务，失败只标那一行。

**死信 topic。** `DefaultErrorHandler` 换成 `DeadLetterPublishingRecoverer`：写审计表重试耗尽、解析失败的消息发到 `launchpad.chain.event.DLT`，内部接口按 offset 区间回灌。现在这两种情况只剩一行日志，消息等于丢了。

**审计表。** `token_address` 列（从 `derived.token` / `args.token` / `payload.address` 抽）给按币回放；`(status, processed_at)` 索引给 retry；按月分区，`PROJECTED` 超过 90 天的行清空 `raw_message`。

## handler：十种事件

写法约定：**事实表 insertIfAbsent 返回 true 才推进派生表**；set 型列无条件写。

```java
boolean inserted = trades.insertIfAbsent(trade);            // 唯一键 (chain_id, tx_hash, log_index)
tokens.setReservesAndPrice(token, quoteReserve, tokenReserve, priceQuote);   // set 型，幂等
tokens.advanceLastTradeAt(token, blockTime);
if (inserted) {                                              // 累加型只走一次
    positions.applyTrade(trade);                             // 买入加成本，卖出结盈亏并写回 trade.pnl_*
    klines.upsertMinute(trade); klines.upsertDay(trade);
    protocolDays.add(trade);
}
```

| 事件 | 事实表 | set 型（无条件） | 累加型（首插成功才做） |
|---|---|---|---|
| QuoteAssetConfigured | `launchpad_quote_asset` upsert | — | — |
| TokenLaunched | `launchpad_token` insertSelective | 反查发行者用户（查不到留空）、解析 `storyFun` 绑叙事、`og_key` | — |
| CurveBuy / CurveSell | `launchpad_trade` | 币行 `quote_reserve` `token_reserve` `price_quote` `last_trade_at`；`price_usd` 由 `priceAt(配对资产, 区块时间)` 固化进 trade | position、kline_minute、kline_day、protocol_day、币行 `trade_count` / `cum_volume_*` |
| LaunchSwept | — | 币行 `curve_closed_at` `swept_quote` `swept_token` `status` | — |
| V4PoolGraduated | — | 币行 `pool_created_at` `pool_id` `pool_position_id` `pool_liquidity` `price_quote` | — |
| PoolRegistered | — | 币行 `pool_id` `pool_quote_asset` | — |
| LaunchGraduationRescued | — | 币行 `rescued_at` `status` | — |
| Swap | `launchpad_trade` | 币行 `price_quote` `pool_liquidity` `last_trade_at` | 同曲线成交；trader 为 null 不进 position |
| Transfer | `launchpad_transfer` | — | `launchpad_balance` from 减 to 加；零地址销毁减 `total_supply`；余额跨 0 时 `holder_count` ±1 |

**USD 固化。** 成交 handler 调 `CoinPriceService.priceAt(pairAsset, blockTime)`：价格历史表里 `priced_at ≤ blockTime` 的最近一行，距离超过 60 分钟给 null。取不到 USD 的成交照写，`amount_usd` 为 null，不事后补。

**持仓成本。** 移动平均：买入 `qty += tokenOut`、`cost_quote += quoteIn`、`cost_usd += amountUsd`；卖出先算均价、释放 `min(tokenIn, qty) × 均价`，超出部分零成本，`pnl_*` 写回这笔 trade 与 position 的累计；恰好归零时成本清零。转入转出只改余额不改持仓。

## 定时线

| 线 | 输入 | 算 | 写 | 频率 |
|---|---|---|---|---|
| **一 · 定价** | 外部价源（[第 6 页](/pricing)） | 各配对资产现价 | `launchpad_coin_price` 追加分钟行 | 每分钟 |
| **二 · 币视图** | 币行 + 余额表 + 价格表最新行 | `price_usd = price_quote × 配对资产现价`、`market_cap_usd = price_usd × total_supply`、`liquidity_usd`、`creator_holding_pct`；新绑定钱包的发行者补 `creator_user_id` | 币行口径列 | 每分钟，一条 UPDATE 全表 |
| **三 · 滚动窗口** | `launchpad_trade` 最近 24h + `launchpad_kline_minute` | `volume_usd_24h`（Σ amount_usd）、`price_change_24h`（现价 vs 24h 前最近一根分钟桶 close） | 币行两列 | 每分钟；没成交的币置 0 |

协议数据页不需要定时线：`launchpad_protocol_day` 由成交 handler 累加，发射数与发射者读时按 UTC 日数。

## 读接口换表

| 接口 | 现在读 | 改读 |
|---|---|---|
| `/market/tokens/*` `/search` | `launchpad_token` | 不变 |
| `/coin/detail` | 币行 + CMC 同步刷 | 币行，不再刷；`priceInPair = price_quote` |
| `/coin/kline` | CMC points / transactions | M5 读 `launchpad_trade` 逐笔；H1 / H6 / D1 读 `launchpad_kline_minute`；ALL ≤ 30 天分钟桶合并，更长读 `launchpad_kline_day`。LTTB 与档位映射保留 |
| `/coin/trades` | CMC lastId 游标 | `launchpad_trade` 按币倒序，游标 `(block_time, id)`；`exchange` 给「曲线」或「Uniswap v4」 |
| `/coin/holders` | CMC 前 100 + RPC 曲线行 | `launchpad_balance` 按币倒序前 100；曲线 / PoolManager 行标 `bondingCurve`；`publicName` / `tags` 恒 null；总数读 `holder_count` |
| `/assets/activity` | `launchpad_activity` | `launchpad_trade` 按 trader；trader 为 null 的不出 |
| `/assets/positions` `/assets/history`（新） | — | `launchpad_position` / `launchpad_trade` 卖出行 |
| `/assets/balances/tokens` | Blockscout | `launchpad_balance` 按 holder，只留发射币 |
| `/assets/balances/quote-tokens` | QuickNode + Blockscout | 待定，见[第 10 页](/rollout) |
| `/analytics/overview` | 整点快照 | `launchpad_protocol_day` 90 天 + 币表按日数 |
| `POST /activities` `GET /activities/{id}` | — | **删除** |

每个读接口前面 Redis 短缓存（几秒），只用来合并并发。

## 回放与重投

| 入口 | 用途 |
|---|---|
| `POST /internal/…/chain-events/replay` ids | 现有，保留 |
| `?tokenAddress=` | 修某个币：该币全部事件按链上顺序重投（新加的 `token_address` 列） |
| `?eventName=&fromBlock=&toBlock=` | 改了某个 handler 后重投这一类；异步，进度落 Redis |
| `POST /internal/…/rebuild` | 全量重建：truncate 事实表 + 派生表 → 按链上顺序回放全部审计行。**必须连事实表一起清**，否则 insertIfAbsent 返回 false、派生表不动 |
| `POST /internal/…/dlt/replay?from=&to=` | 死信回灌 |
| `ChainEventRetryJob` | 现有，保留；乱序场景靠它 |

四种回放都走 `ChainEventProjector.project`，与首次消费同一入口。

## 删除清单

- **上报链路**：`controller/ActivityController`、`controller/internal/ActivityAdminController`、`service/activity/{ActivityReportService, ActivityResolveService, ActivityResolveTrigger, ActivityProperties, ActivityConfirmedEvent, RepositoryTokenLookup}`、`job/ActivityResolveJob`、`config/ActivityAsyncConfig`、`dto/activity/*`、`enums/ActivityStatus`、`chain/decode/{ReceiptDecoder, TokenLookup, PoolToken, TokenNetFlow, CurveTrades, ContractProbe}`、yml `launchpad.activity.*`、`docs/adr/0002`
- **CMC**：`cmc/*`、`market/source/*`、`config/{CmcConfig, MarketSourceConfig, MarketRefreshAsyncConfig}`、`service/market/{MarketRefreshService, MarketRefreshTrigger}`、`job/{MarketSweepJob, CmcQuotaMonitor}`、`price/CmcDexPriceSource`、yml `launchpad.cmc.*`、`CMC_API_KEY`
- **RPC**：`chain/{ChainRpcClient, ChainRpcException, RpcContractProbe, ChainProperties}`、`config/ChainConfig`、web3j / okhttp 依赖、`LaunchpadConfigService.rpcHttpUrl`、yml `launchpad.chain.*`
- **Blockscout**：`explorer/*`、`config/ExplorerConfig`、`service/assets/{BalanceSnapshotService, NativeBalanceSnapshot, TokenBalanceSnapshot}`、yml `launchpad.explorer.*`、`docs/explorer-smoke.sh`
- **旧扫链契约**：`service/chain/pons/*`、`service/chain/PairedAssetResolver`、`repository/IgnoredLaunchRepository`、`entity/IgnoredLaunch`、`enums/LaunchSource`、`pons.event` 监听与 `KafkaConstants.TOPIC_PONS_EVENT`、`docs/chan.msg.md`、`PonsEventMessage` / `PonsEventParser`（重写为 `ChainEvent*`）
- **表**：全部旧 `launchpad_*` 表 DROP，按[第 7 页](/tables)重建；`service/analytics/VolumeSnapshotService`、所有 entity / repository 按新列重写
- **测试**：上述模块的单测与 `MarketRefreshLiveIT` / `ChainRpcClientIT`；`src/test/resources/{cmc, explorer}/*.json` 换成 `storyfun/*.json` 样例消息
- `CLAUDE.md`「行情」「币价与 USD 折算」「活动：两个来源」「链上余额」「链上事件」五节重写
