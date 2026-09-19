---
title: 6 · 只需要几个配对资产的价，其余全是乘法
---

# 只需要几个配对资产的价，其余全是乘法

链上只知道「一个币值多少个配对资产」。配对资产是 WETH、USDG、cbBTC 和股票代币这类全球有价的资产，五六个，它们的美元价不该由 Robinhood 链上一个薄池来定，所以**不索引价格池**，沿用 `CoinPriceService` 那条线，按资产类型分路由。发射的币没有自己的价源，**永远是「以配对资产计的数 × 该配对资产的美元价」**。CMC 整体下线。

## 线一 · PriceSource 按资产路由

```java
interface PriceSource {
    String name();                                              // 落 launchpad_v2_coin_price.source
    Map<String, CoinPriceQuote> fetchSpot(List<QuoteToken> assets);   // 一轮取一批；失败返回空 map，不抛
}
// CoinPriceService.refresh()：按下表把名单里的资产分到各个源 → 各源一次调用 → 合并 → 落库
```

路由**不加配置字段**，由名单里已有的信息定（09-19 定）：

| 资产 | 怎么认出来 | 来源 | 说明 |
|---|---|---|---|
| 稳定币 USDG | 代码里写死的代号集合（目前只有 `USDG`） | 常量 1 | 不发请求，每分钟照样落一行，`source = FIXED_1` |
| 股票代币 NVDA / AAPL / TSLA / AMZN | 名单里 `isStock: true` | Robinhood `GET /rhj/prices/{symbol}`，bid / ask 中间价 × `/assets` 的 `currentMultiplier` | 代号就是名单的 `symbol`；`isTradingHalt` 为真这一轮不落行（沿用上一个价）。**第一批先用录制的响应做单测，真实调用后接**，接上之前股票配对的币 USD 为 null |
| 其余：ETH / WETH / cbBTC | 既不是稳定币也不是股票 | 交易所现货，**币安主、Coinbase 备** | 交易对代号取名单里可选的 `priceSymbol`，没填就用 `symbol`：WETH 填 `ETH`，cbBTC 填 `BTC`，ETH 不用填。币安 `{priceSymbol}USDT`，Coinbase `{priceSymbol}-USD` |
| 名单里没有的配对资产 | — | — | USD 字段一律 null，前端显示「—」，不猜 |

admin 的 `chainlinks[chain].tokens[*]` **只加一个可选字段 `priceSymbol`**，与 `isStock` 同级；不加 `priceSource`。

**主备规则（只此一条）**：每一轮先问币安；这一轮失败（超时、非 200、HTTP 451 拒区）就当轮改问 Coinbase；两家都失败这一轮不落行，读侧自然沿用上一个价。不记「上次谁成功」，不做熔断，下一轮照样先问币安。币安拒美区 IP，dev / test 在俄亥俄实际每轮都走 Coinbase，prod 东京走币安；落库的 `source` 列记这一行实际来自哪家。`BinanceCoinPriceSource` 在 `backup/dev-before-cmc-refactor-20260910` 分支里可以参考。

::: tip 实现后补的四条（09-19）
- **资产的身份是合约地址**（原生币用全零地址），不是代号：价格表按地址存，`priceAt` / `currentPrice` 传配对资产地址。代号只用来拼交易对。
- **dev 上股票永远没有价**：券商行情里只有主网 4663 的部署地址，dev 是测试网 46630，按地址对不上就整批跳过（告警按资产每小时一次）。这是「按部署地址认资产、不按代号」的必然结果，不是故障。
- 币安的交易对是 `…USDT`，Coinbase 是 `…-USD`，两者的价差（USDT 脱锚幅度）直接接受，不换算。
- 「不熔断」的代价是：美区机房每一轮都会先白问一次币安、拿一个 451、打一条 WARN，再去问 Coinbase。接受。
:::

频率每分钟；**每分钟一行**，六个资产一年约三百万行；原生币与 WETH 同价，各落一行。

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

`launchpad_v2_coin_price` 就是价格历史。**成交 handler 按区块时间读它**给每笔成交、每个桶固化 USD；线二读最新一行算现价类 USD。

```java
// CoinPriceService
Optional<BigDecimal> priceAt(String asset, long blockTimeMillis);   // priced_at ≤ blockTime 的最近一行；没有就取表里最早的一行；表里一行都没有才 empty
Optional<BigDecimal> currentPrice(String asset);                    // 最新一行，不看多旧；一行都没有才 empty
```

::: tip USD 在写入时固化，但必须按区块时间取价
消费跟着链头跑时，「≤ 区块时间的最近一行」拿到的就是最新一行，等价于实时价。差别只在三种情况出现：首次上线回填历史、停机后追消息、回放。这时候拿今天的 ETH 价乘上周的成交是错的。所以**价格历史表是固化 USD 的前提**，「实时价」只是它的最新一行。

**有价总比没价好（用户 09-18 定）：取已知的最近价格，不因为价格旧就给 null。** 线一停机期间的成交用停机前最后一行；价格历史开始之前的成交用最早的一行。只有该资产一行价格都没有（从未配价源）才为 null。价格比区块时间旧超过一小时时打一条 WARN，只为发现线一停了，不影响取值。**不事后补**：写下的 USD 不再改。
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

**主备只在 ETH 系的两家交易所之间，类与类之间不互相兜底。** 两家交易所都挂了只影响 ETH 系资产，Robinhood 挂了只影响股票代币，各自沿用上一个价；从来没有过价的才是 null。
:::
