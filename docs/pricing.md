---
title: 6 · 只需要几个配对资产的价，其余全是乘法
---

# 只需要几个配对资产的价，其余全是乘法

链上只知道「一个币值多少个配对资产」。配对资产是 ETH、USDG 和股票代币这类全球有价的资产，十几个，它们的美元价不该由 Robinhood 链上一个薄池来定，所以**不索引价格池**。发射的币没有自己的价源，**永远是「以配对资产计的数 × 该配对资产的美元价」**。

## 线一 · 名单与价格都来自平台的配对资产接口（09-22 定）

平台已有一个配对资产接口 `GET /v1/quote-assets`（无参数），一次返回全部配对资产的**名单与美元现价**：

| 字段 | 说明 |
|---|---|
| `address` | 合约地址（混合大小写，入库转小写）；**链原生币 ETH 是全零地址** |
| `symbol` / `name` / `logo` | 代号、全名、图标 |
| `decimals` | 最小单位精度，消息里的配对资产数量按它换成整枚 |
| `usd_price` | 美元现价，字符串 |

线一（`CoinPricePollJob` → `CoinPriceService.refresh()`，Redis 锁保证多节点只有一个在抓）**每分钟调一次**，做三件事：

1. **名单 upsert 进 `launchpad_v2_quote_asset`**：新资产插入；代号 / 全名 / 精度 / 图标 / 顺序变了就更新；**接口里消失的资产不删**（已发射的币还要它的精度）。
2. **每个有价的资产往 `launchpad_v2_coin_price` 追加一行**，`source = STORYFUN`，`priced_at` 取本轮整分钟。价格没变也照写 —— 表是整齐的分钟序列，缺行就说明线一停了。价格按 8 位小数舍入；价格缺失或 ≤ 0 的资产照样进名单，这一轮不落价。
3. 刷新内存里的名单（`QuoteAssetService`）。没抢到锁的节点按固定间隔重读名单表。

接口地址是配置项 `launchpad.quote-assets.base-url`，按环境写在 profile 配置里，**没有默认值**：缺了启动失败，不会悄悄连错环境。

::: tip 取代了什么
- **09-19 的「按资产种类路由」整套下线**：稳定币恒 1、股票问券商行情、其余问交易所现货（币安主 Coinbase 备）、名单上的 `isStock` / `priceSymbol` 字段，全部删除。USDG 也用接口给的价（如 1.00008），不再写死 1。
- **名单不再来自 admin Redis 的 `quoteTokens`**。admin 那边只提供链与 RPC；配对资产名单的唯一来源是 `launchpad_v2_quote_asset`。
- **行情搜索的 `pairAsset=STOCKS` 筛选删除**（没有 `isStock` 了），以后要再加。
- **不考虑接口挂**：成功同步过一次，名单与价格就都在库里；接口失败那一轮只打 WARN、不写，读侧沿用上一个价。接口不带价格时间戳 —— 调用时拿到的就当是这一分钟的价。
:::

::: warning 名单里没有的配对资产
发币消息要按配对资产的精度把数量换成整枚。名单表里还没有这个配对资产（接口刚加、线一还没同步到）时，这条发币消息 **FAILED**，等下一轮同步进名单后由重投补上。**绝不按 18 位猜**（USDG 是 6 位，会差 10¹²）。
:::

## 发射币的价格从哪来：曲线阶段和毕业后是同一条路

发射币没有自己的价源，也不需要 Java 去查任何池子。**价格是每一笔成交的副产品**，随成交消息一起到，Java 只 set：

| 阶段 | 价格在哪定 | 谁算 | 怎么到 Java |
|---|---|---|---|
| 曲线 | 曲线合约的两个储备（常数乘积） | Envio：每笔 CurveBuy / CurveSell 后 `(initialVirtualQuoteReserve + trackedNetQuote) ÷ (VIRTUAL_TOKEN_OFFSET + trackedTokens)` | `CurveBuy` / `CurveSell` 消息的 `derived.priceQuote` |
| 建池那一刻 | `V4PoolGraduated.sqrtPriceX96` | Envio 换算成「一枚本币值多少配对资产」，已按 currency0 / 1 方向与两侧精度处理 | `V4PoolGraduated` 消息的 `derived.priceQuote` |
| 毕业后 | Uniswap v4 池里本币 ↔ 配对资产的价，**只在 Swap 时变**（加减流动性不改价） | Envio：每笔 `Swap` 后的 `sqrtPriceX96` 换算 | `Swap` 消息的 `derived.priceQuote` |

Java 收到就 set `launchpad_v2_token.price_quote`，同时写进这笔 `launchpad_v2_trade.price_quote` 与 K 线桶；线二每分钟乘配对资产现价得 `price_usd` / `market_cap_usd`。两笔 Swap 之间价格不动，库里的值就是链上的值，不用轮询池子。

::: tip 三点说明
- **时效**：一笔 Swap 上链 → Envio 处理该区块并达到确认深度 → 消息到 Java → 落库，秒级；对列表和详情足够，K 线本来就按分钟分桶。
- **不会漏**：所有池内成交都经 PoolManager 的 `Swap`，Envio 按 poolId 过滤后全部投出；没有别的路径能改池价。
- **计价资产**：池的配对资产就是发币时的 `quoteAsset`（Receiver 用它建池），USD 折算用它在价格历史表里的价。Java 不存池子信息，池价与流动性都随消息来。
:::

## 历史价：成交 handler 与定时线共用的一张表

`launchpad_v2_coin_price` 就是价格历史。**成交 handler 按区块时间读它**给每笔成交、每个桶固化 USD；线二、详情页、余额页读最新一行算现价类 USD（现价只存这一处，名单表不存价）。

```java
// CoinPriceService
Optional<BigDecimal> priceAt(String asset, long blockTimeMillis);   // priced_at ≤ blockTime 的最近一行；没有就取表里最早的一行；表里一行都没有才 empty
Optional<BigDecimal> currentPrice(String asset);                    // 最新一行，不看多旧；一行都没有才 empty
```

::: tip USD 在写入时固化，但必须按区块时间取价
消费跟着链头跑时，「≤ 区块时间的最近一行」拿到的就是最新一行，等价于实时价。差别只在三种情况出现：首次上线回填历史、停机后追消息、回放。这时候拿今天的 ETH 价乘上周的成交是错的。所以**价格历史表是固化 USD 的前提**，「实时价」只是它的最新一行。

**有价总比没价好（用户 09-18 定）：取已知的最近价格，不因为价格旧就给 null。** 线一停机期间的成交用停机前最后一行；价格历史开始之前的成交用最早的一行。只有该资产一行价格都没有（接口从未给过它的价）才为 null。价格比区块时间旧超过一小时时打一条 WARN，只为发现线一停了，不影响取值。**不事后补**：写下的 USD 不再改。
:::

## 每个 USD 数字取价的时点

| 数字 | 乘的是哪个价 | 谁算 |
|---|---|---|
| 现价、市值、流动性 | 配对资产**现价** | 线二，每分钟 UPDATE 全表 |
| 24h 成交额 | 成交表里已固化的 `amount_usd` 求和 | 线三 |
| K 线每个点、成交每一行、Activity 每一行、持仓成本 | 该笔**区块时间**的价 | 成交 handler |
| 协议日成交额 | 每笔成交各自区块时间的价累加 | 成交 handler 写 `launchpad_v2_protocol_day` |

## 两条规则

::: warning
**历史价只来自我们自己每分钟落的行**，不依赖任何历史价 API。取价永远是「已知的最近一行」，停机期间用停机前的价，事后不补。

**价格表永久保留、不清理**（用户 09-22 定）：重放 / 重建要按当时的价重算 USD，对方接口只给现价，删了就再也拿不回来。
:::
