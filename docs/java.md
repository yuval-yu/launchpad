---
title: 5 · Java 改造点：消费、投影、派生、读接口
---

# Java 改造点：消费、投影、派生、读接口

现有的「Kafka → 解析 → 审计表 → `ChainEventProjector` → handler」管线的**代码骨架**保留（监听、审计、按事件名分发、独立事务、状态回写、重投、回放），其余按新方案重写：一条 topic、按 `eventName` 路由、十个新 handler；旧 handler、旧表、`launch_source` 概念整体删除，不留兼容。改动集中在四处：消费管线的吞吐与可靠性、handler 与派生表、定时线、读接口换表。删除的东西在最后一节。

## 改什么，一览

| 模块 | 处置 | 说明 |
|---|---|---|
| `mq/consumer` · `service/chain` 分发 | **改** | 监听 `launchpad.chain.events`；`ChainEventParser` 校验新信封（`txFrom` / `derived`）；registry 只按 `eventName` 路由，`LaunchSource` 删除；批量消费 + 分区并行；死信 topic |
| `service/chain/pons/*` | **删** | PONS（之前接的外部发射台）时代的 handler 六个、`PonsArgs`、平台归属判定、`PairedAssetResolver`、负向表 |
| `service/chain/handler/*` | **新** | 九种事件的 handler，见下 |
| `service/activity/*` · `controller/ActivityController` · `job/ActivityResolveJob` · `chain/decode/*` | **删** | 前端上报整条链路；`ActivityWriter` 的两来源合并退化成 insertIfAbsent |
| `cmc/*` · `market/source/*` · `service/market/MarketRefreshService` / `Trigger` · `job/MarketSweepJob` / `CmcQuotaMonitor` | **删** | CMC 全部 |
| `chain/ChainRpcClient` | **缩** | 只留 `eth_getBalance` 与 ERC-20 `balanceOf` 两个方法，只给配对资产余额接口用（[第 2 页](/facts)的例外）；其余方法、`RpcContractProbe`、`decode/*` 删 |
| `explorer/*` · `service/assets/BalanceSnapshotService` | **删** | Blockscout |
| `price/CmcDexPriceSource` → `price/PriceSource` 接口 + 实现 | **换** | 按资产路由；`CoinPriceService` 加 `priceAt` |
| `service/market/KlineService` · `MarketFeedService` · `TokenDetailService` · `service/assets/*` · `AnalyticsService` | **改** | 改读自家表，接口形状不变 |
| `zeroex/*` · `controller/ZeroExGaslessController` | **不动** | 暂时保留（09-19 定）；只转发前端请求，不读链 |
| `job/*` 定时线 | **改** | 线一定价（有）、线二币视图（新）、线三滚动窗口（新） |
| `controller/internal/*` | **改** | 回放加按币、按事件、全量重建；死信回灌 |

## 消费管线

**监听与解析。** `@KafkaListener(topics = "launchpad.chain.events")`；`ChainEventMessage` / `ChainEventParser` 按[第 4 页](/messages)的信封写，只校验信封，`derived` 与 `args` 一样交给 handler。审计表唯一键只剩 `event_id`。

**不做入库前过滤。** 工厂发的全收，没有「是不是我们的币」的判断。**认币**：曲线事件与 Swap 读 `payload.token.token`（契约必须），Transfer 的 `payload.address` 就是 token；没有 token 的成交消息直接 FAILED，那是契约错误，不做按 curve / poolId 反查的兜底（09-19 定，两条索引随之删除）。查不到 = 发币消息还没到 → WAITING_TOKEN，TokenLaunched 投影后按币重投。

**批量消费 + 分区并行。** `listener.type: batch`，一次 poll 100～500 条，批内**逐条**落审计再投影，整批 ack（不做一条 `INSERT IGNORE` 批量落审计：批量插入拿不到每行的自增 id，而投影要用它；也给不出「这一批里到底哪条失败」的准确下标——只有失败那条及其后的记录该被重试，前面已成功的不该重来）；`listener.concurrency` = 分区数。投影仍逐条独立事务，失败只标那一行。

**死信 topic。** `DefaultErrorHandler` 换成 `DeadLetterPublishingRecoverer`：写审计表重试耗尽、解析失败、**`chainId` 与配置不符**的消息发到 `launchpad.chain.events.DLT`，内部接口按**时间范围**回灌（运维知道的是「几点到几点」，不是 offset）；回灌走正常的入库入口，链 id 不符的消息回灌后仍然不符，只计入「仍失败」，不再写回死信。现在前两种情况只剩一行日志，消息等于丢了。

**chainId 只做一件事。** 只接一条链，`chainId` 在消息、每张表、唯一键里都保留，但 Java 里唯一用它的地方是解析层：不等于 admin 配置的链就进死信，不落审计表。这是防「测试网的 Envio 误配到主网库」的护栏；除此之外任何代码不许按 chainId 分支。

**审计表。** `token_address` 列（从 `payload.token.token` / `args.token` / `payload.address` 抽）给按币回放；`kafka_key` 列与 `kafka_partition` / `kafka_offset` 放一起，排障时能看出分区是不是按币分的；`(status, processed_at)` 索引给 retry；按月分区，`PROJECTED` 超过 90 天的行清空 `raw_message`。

**Kafka key 只核对、不定业务。** 监听器用 `@Header(KafkaHeaders.RECEIVED_KEY)`（批量模式 `record.key()`）拿到 key，解析层比对「key == 这条消息反查出的 token」，不等打 WARN。认币始终按消息体（曲线 `payload.address` 查 `curve_address`、Swap `args.id` 查 `pool_id`、Transfer `payload.address`），Envio 将来改键 Java 不用动。

## handler：九种事件

写法约定：**事实表 insertIfAbsent 返回 true 才推进派生表**；set 型列无条件写。handler 里只有对消息字段的落库和对自家表的算术，**没有合约数学、没有 ERC20 语义**（见[第 2 页](/facts)）。唯一的合约知识是 `LaunchConstants` 里三个编译死的常量：`TOTAL_SUPPLY = 1e9 × 1e18`、`TOKEN_DECIMALS = 18`、铸给曲线的初始余额 = `TOTAL_SUPPLY`（用户 09-18 定：全局常量不走消息）。

```java
// 同一个事务里
Position pos = positions.lock(chainId, trader, token);        // SELECT … FOR UPDATE，没有就是空持仓
Trade trade = Trade.from(msg, priceAt(...), pos);             // 卖出行的 pnl_* 在这里用「卖出前的持仓」算好，不回填
boolean inserted = trades.insertIfAbsent(trade);              // 唯一键 (tx_hash, log_index, block_time)；重复 → false
tokens.setReserveAndPrice(token, quoteReserve, priceQuote);                  // set 型，幂等；曲线阶段 liquidity_quote = quoteReserve × 2
tokens.advanceLastTradeAt(token, blockTime);
if (inserted) {                                               // 累加型只走一次
    positions.apply(pos, trade);                              // 买入加成本，卖出扣成本、累加已实现盈亏
    klines.upsertMinute(trade); klines.upsertHour(trade);
    protocolDays.add(trade);
}
```

**`launchpad_v2_trade` 只插入、不更新，一个例外。** 交易者、USD、盈亏全部在插入前定好：交易者来自消息，USD 按区块时间取价一次固化，盈亏用插入前锁住的持仓算。重复投递 `insertIfAbsent` 返回 false 不碰行；全量重建是 truncate 再插；USD 缺价不事后补。唯一的例外是**迟到成交触发的持仓重算**会重写同一对 (trader, token) 里卖出行的五个 `pnl_*` 列（见「乱序与补发」）。

| 事件 | 事实表 | set 型（无条件） | 累加型（首插成功才做） |
|---|---|---|---|
| TokenLaunched | `launchpad_v2_token` insertSelective | 反查发行者用户（查不到留空）、解析 `storyFun` 绑叙事、`og_key`；`total_supply` / `token_decimals` 取 `LaunchConstants`；写曲线的余额行（balance = `TOTAL_SUPPLY`，kind = CURVE），`holder_count = 1`，并把 `supply_state_*` 水位线设成这条发币事件的位置（铸币的 Transfer 扫链不发，发币就是供应类列的起点）。`storyFun` 填了但认不出路径时**不**回落 `website`，只在它为空时才看 `website`；绑不上只 WARN，币照收 | — |
| CurveBuy / CurveSell | `launchpad_v2_trade`（trader = 消息给的 `derived.trader`，没给取 `recipient` / `seller`） | 币行 `quote_reserve` `price_quote` `last_trade_at`，`liquidity_quote = quote_reserve × 2`；累加型里含 `cum_volume_usd`（VOLUME 排序键）；`price_usd` 由 `priceAt(配对资产, 区块时间)` 固化进 trade | position、kline_minute、kline_hour、protocol_day、币行 `trade_count` / `cum_volume_*` |
| CurveCompleted | — | 币行 `curve_closed_at` `swept_quote` `swept_token` `status` | — |
| V4PoolGraduated | — | 币行 `pool_created_at` `pool_id` `price_quote` `liquidity_quote` | — |
| PoolRegistered | — | 币行 `pool_id` | — |
| LaunchGraduationRescued | — | 币行 `rescued_at` `status` | — |
| Swap | `launchpad_v2_trade` | 币行 `price_quote` `liquidity_quote` `last_trade_at` | 同曲线成交；trader 为 null 不进 position |
| Transfer | — | `launchpad_v2_balance` 两行 set 成消息里的绝对值与 kind；币行 `total_supply` `holder_count` set | — |
| Heartbeat | 不落审计 | `launchpad_v2_indexer_state` 一行 upsert（head_block / processed_block / processed_block_time / heartbeat_at）；lag 告警、余额页 `syncedAt`、Envio 是否活着都读它 | — |

**USD 固化。** 成交 handler 调 `CoinPriceService.priceAt(pairAsset, blockTime)`：价格历史表里 `priced_at ≤ blockTime` 的最近一行，没有就取最早的一行，**不因为价格旧就放弃**（有价总比没价好，用户 09-18 定）。只有该资产从未有过价（没配价源）才为 null。写下就不再改。

**K 线桶只在有成交时写。** 两种桶：分钟与小时（用户 09-18 定，不建日桶，日按 24 个小时桶读时合并）。桶由成交 handler 在首插成功时 upsert：该分钟 / 该小时第一笔建行（open = 这笔成交后价），之后的成交只更新 high / low / close / 量 / 笔数。**没有成交的分钟不存行，没有定时任务补空桶**。读接口画图时遇到空档怎么处理（延续上一根收盘价，还是断开）是展示口径，在响应里做，不落库。

**持仓成本。** 移动平均：买入 `qty += tokenOut`、`cost_quote += quoteIn`、`cost_usd += amountUsd`；卖出先算均价、释放 `min(tokenIn, qty) × 均价`，超出部分零成本，`pnl_*` 写回这笔 trade 与 position 的累计；恰好归零时成本清零。转入转出只改余额不改持仓。

## 乱序与补发：唯一性靠 event_id，正确性靠水位线、锚点、重算

Envio 漏发后补发，消息是**乱序**到达的：一条更早的事件在更晚的事件之后才来。去重靠审计表 `event_id` 唯一键，重复的拒掉、漏的补上；但派生表要能吃下乱序，四条规则：

1. **set 型状态带水位线。** 币行分两组：成交类列（`price_quote` / `liquidity_quote` / `quote_reserve`）用 `trade_state_*`，Transfer 类列（`total_supply` / `holder_count`）用 `supply_state_*`，各自只在事件的 `(block_number, log_index)` **大于**本组水位线时才写并推进；余额表的 `balance` 一个水位线。分两组是因为两组由不同事件写，共用一个会让一条迟到的 Transfer 被更新的成交挡掉，`holder_count` 停在旧值。更早的事件跳过。消息给的是绝对值，所以跳过就是对的。`last_trade_at` 本来就只往后推。**`status` 与毕业时间不走水位线**：它们单向，用「还在曲线阶段才写」的条件——毕业后的 Swap 会把成交水位线推到比 CurveCompleted 更新，共用条件会让迟到的 CurveCompleted 永远写不进去、币停在曲线分区；Rescued 同理。CurveCompleted 带的关闭时储备两列（纯存档）归成交组水位线，被挡下也无妨。
2. **K 线桶记开收锚点。** 桶上存 `open_block / open_log` 与 `close_block / close_log`：迟到的一笔若早于 open 锚点就替换 `open`，晚于 close 锚点就替换 `close`，`high` / `low` 取极值，量与笔数只在成交行首插成功时加。这样桶与到达顺序无关。
3. **持仓是路径依赖的，迟到就重算。** 移动平均成本按顺序算，一笔迟到的成交会让它之后该地址在该币上所有成交的 `cost_*` / `pnl_*` 都错。成交 handler 插入成功后比较：这笔的 `(block, logIndex)` 小于 `launchpad_v2_position.applied_block / applied_log` → 不做增量，改为**重算这一对 (trader, token)**：把该对全部成交按链上顺序重放，重写 position 行与每笔卖出的 `pnl_*`。这是 `launchpad_v2_trade` 唯一允许 UPDATE 的路径，且只动 `cost_*_released` / `pnl_*` 五列，链上事实列不动。一对的成交通常几十笔，重算是毫秒级。
4. **「币还没到」不设重试上限。** 所有依赖币行的事件（成交、Transfer、CurveCompleted、毕业三事件）先于 TokenLaunched 到达时，按老做法会进 FAILED，`ChainEventRetryJob` 现在只重投 2 小时内、5 次以内的行；补发可能晚于 2 小时。把「token 不存在」这一类错误标成 `WAITING_TOKEN`，不计次数、不看窗口，TokenLaunched 投影成功**并提交之后**立即按币、按链上顺序重投它们。handler 的约定：先查币行，查不到立刻抛 `TokenNotReadyException`（事务回滚），不要写到一半才抛。等待行如果永远等不到币，就一直停在 `WAITING_TOKEN`，从各状态行数的指标上看得见。

不需要处理的：`launchpad_v2_trade` insert-only；`launchpad_v2_protocol_day` 纯累加；线三每分钟从成交表重算 24h 与涨跌，天然与顺序无关。

::: tip 一句话验收标准
把测试网某个币的消息随机打乱、抽掉三分之一再补发，跑完后十一张表与按顺序消费一次的结果逐字节一致。P2 的对账脚本就按这个写。
:::

## 定时线

| 线 | 输入 | 算 | 写 | 频率 |
|---|---|---|---|---|
| **一 · 定价** | 外部价源（[第 6 页](/pricing)） | 各配对资产现价 | `launchpad_v2_coin_price` 追加分钟行 | 每分钟 |
| **二 · 币视图** | 币行 + 余额表 + 价格表最新行 | `price_usd = price_quote × 配对资产现价`、`market_cap_usd = price_usd × total_supply`、`liquidity_usd = liquidity_quote × 配对资产价`（流动性由 Envio 给，Java 不存池子信息）、`creator_holding_pct`；新绑定钱包的发行者补 `creator_user_id` | 币行口径列 | 每分钟，一条 UPDATE 全表 |
| **三 · 滚动窗口** | `launchpad_v2_trade` 最近 24h + `launchpad_v2_kline_minute` | `volume_usd_24h`（Σ amount_usd）、`price_change_24h`（现价 vs 24h 前最近一根分钟桶 close）。两者只作展示，**排序用的是累计成交额 `cum_volume_usd` 与市值**，由 handler 与线二维护 | 币行两列 | 每分钟；没成交的币置 0 |

协议数据页不需要定时线：`launchpad_v2_protocol_day` 由成交 handler 累加，发射数与发射者读时按 UTC 日数。

**线二、线三只写真变了的行（09-19 定）。** 币表是宽表，四条列表排序索引挂在每分钟要改的列上，全表 UPDATE 等于每分钟把索引重写一遍。所以：线二先比各配对资产这一分钟的价和上一分钟，没变的资产整组跳过，变了的只 UPDATE 那组币且 `WHERE price_usd <> 新值`；线三只碰 24h 内有成交滑入或滑出的币，两个值都是 0 的行不写。每分钟真正写的行从「全部」降到「活跃的」。到十万个币这仍不够时，把热列拆成 `launchpad_v2_token_stats`，见[第 7 页](/tables)「拆表信号」。

## 读接口换表

| 接口 | 现在读 | 改读 |
|---|---|---|
| `/market/tokens/*` `/search` | `launchpad_v2_token` | 不变 |
| `/coin/detail` | 币行 + CMC 同步刷 | 币行，不再刷；`priceInPair = price_quote` |
| `/coin/kline` | CMC points / transactions | M5 读 `launchpad_v2_trade` 逐笔；H1 / H6 / D1 读 `launchpad_v2_kline_minute`；ALL 读 `launchpad_v2_kline_hour` 按跨度合并成 2h / 12h / 1d / 1w / 1M（一年也只有 8,760 行）。LTTB 与档位映射保留 |
| `/coin/trades` | CMC lastId 游标 | `launchpad_v2_trade` 按币倒序，游标 `(block_time, id)`；`exchange` 给「曲线」或「Uniswap v4」 |
| `/coin/holders` | CMC 前 100 + RPC 曲线行 | `launchpad_v2_balance` 按币倒序前 100；`holder_kind = CURVE` 的行标 `bondingCurve`，其余非 USER 的剔除；`publicName` / `tags` 恒 null；总数 = `holder_count` 减非 USER 行数 |
| `/assets/activity` | 旧 `launchpad_activity` | `launchpad_v2_trade` 按 trader；trader 为 null 的不出 |
| `/assets/positions` `/assets/history`（新） | — | `launchpad_v2_position` / `launchpad_v2_trade` 卖出行 |
| `/assets/balances/tokens` | Blockscout | `launchpad_v2_balance` 按 holder，只留发射币 |
| `/assets/balances/quote-tokens` | QuickNode + Blockscout | **保留，后端查链**：`eth_getBalance` + 名单内 ERC-20 `balanceOf`，30 秒缓存，失败给旧值；Blockscout 去掉。边界见[第 2 页](/facts) |
| `/analytics/overview` | 整点快照 | `launchpad_v2_protocol_day` 90 天 + 币表按日数 |
| `POST /activities` `GET /activities/{id}` | — | **删除** |

每个读接口前面 Redis 短缓存（几秒），只用来合并并发。

## 回放与重投

| 入口 | 用途 |
|---|---|
| `POST /internal/…/chain-events/replay` ids | 现有，保留 |
| `POST /internal/…/chain-events/replay/by-token` | 修某个币：该币全部事件按链上顺序重投（新加的 `token_address` 列）。单次上限 5000 条，到顶返回下一段的游标续跑；按（区块号，日志序号）游标翻页而不是 offset——重投会改 status，offset 在边读边改下会漏行 |
| `POST /internal/…/chain-events/replay/by-event`（`eventName`、`fromBlock`、`toBlock` 闭区间） | 改了某个 handler 后重投这一类；异步，立即返回任务 id，进度落 Redis（保留 7 天），`GET …/replay/tasks/{taskId}` 查。**区间给窄一点**：审计表没有按事件名的索引（不值得在最热的写入表上多维护一棵树），代价与区间内的总行数成正比，别用 `fromBlock=0` 扫全表 |
| `POST /internal/…/chain-events/rebuild`（`confirm=REBUILD`，不对就 400） | 全量重建：`TRUNCATE` 成交、余额、持仓、两档 K 线、协议日统计、币行、叙事绑定八张表（价格历史、审计表、扫链状态表不清）→ 按链上顺序回放全部审计行；异步，同上查进度。**必须连事实表一起清**，否则 insertIfAbsent 返回 false、派生表不动。重建期间「币与内容已绑定」的 Kafka 通知整段抑制（绑定行被清空会让它重发一遍）；开始时暂停本节点的链上事件消费、结束时恢复——多节点时**执行前先停掉其它节点的消费**。表清空到重投完这段时间读接口的数据不完整，挑没人的时候跑 |
| `POST /internal/…/dlt/replay?from=&to=` | 死信回灌 |
| `ChainEventRetryJob` | 现有，保留；乱序场景靠它 |

四种回放都走 `ChainEventProjector.project`，与首次消费同一入口。异步的两种（按事件、全量重建）同一时刻只允许一个在跑，已有任务时返回 409。

## 删除清单

- **上报链路**：`controller/ActivityController`、`controller/internal/ActivityAdminController`、`service/activity/{ActivityReportService, ActivityResolveService, ActivityResolveTrigger, ActivityProperties, ActivityConfirmedEvent, RepositoryTokenLookup}`、`job/ActivityResolveJob`、`config/ActivityAsyncConfig`、`dto/activity/*`、`enums/ActivityStatus`、`chain/decode/{ReceiptDecoder, TokenLookup, PoolToken, TokenNetFlow, CurveTrades, ContractProbe}`、yml `launchpad.activity.*`、`docs/adr/0002`
- **CMC**：`cmc/*`、`market/source/*`、`config/{CmcConfig, MarketSourceConfig, MarketRefreshAsyncConfig}`、`service/market/{MarketRefreshService, MarketRefreshTrigger}`、`job/{MarketSweepJob, CmcQuotaMonitor}`、`price/CmcDexPriceSource`、yml `launchpad.cmc.*`、`CMC_API_KEY`
- **链上处理**：`chain/` 包里除缩减后的 `ChainRpcClient` 之外的全部（`RpcContractProbe`、`decode/*` 含 `ChainEvents` 的 topic 常量），`ChainRpcClient` 里查余额之外的方法。仓库里不再有 ABI、事件签名；`eth_*` 只剩 `eth_getBalance` 与 `eth_call(balanceOf)`。`LaunchpadConfigService.rpcHttpUrl` 与 HTTP 客户端依赖因此保留
- **Blockscout**：`explorer/*`、`config/ExplorerConfig`、`service/assets/{BalanceSnapshotService, NativeBalanceSnapshot, TokenBalanceSnapshot}`、yml `launchpad.explorer.*`、`docs/explorer-smoke.sh`
- **PONS 时代的契约**：`service/chain/pons/*`、`service/chain/PairedAssetResolver`、`repository/IgnoredLaunchRepository`、`entity/IgnoredLaunch`、`enums/LaunchSource`、`pons.event` 监听与 `KafkaConstants.TOPIC_PONS_EVENT`、`docs/chan.msg.md`、`PonsEventMessage` / `PonsEventParser`（重写为 `ChainEvent*`）
- **表**：新表全部 `launchpad_v2_` 前缀，按[第 7 页](/tables)新建；旧 `launchpad_*` 表不动，删不删以后再定；`service/analytics/VolumeSnapshotService`、所有 entity / repository 按新列重写
- **测试**：上述模块的单测与 `MarketRefreshLiveIT`（`ChainRpcClientIT` 缩到只测查余额）；`src/test/resources/{cmc, explorer}/*.json` 换成 `storyfun/*.json` 样例消息
- `CLAUDE.md`「行情」「币价与 USD 折算」「活动：两个来源」「链上余额」「链上事件」五节重写
