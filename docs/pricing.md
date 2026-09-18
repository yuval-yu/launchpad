---
title: 6 · 只需要几个配对资产的价，其余全是乘法
---

# 只需要几个配对资产的价，其余全是乘法

链上只知道「一个币值多少个配对资产」。配对资产是 WETH、USDG、cbBTC 和股票代币这类全球有价的资产，五六个，它们的美元价不该由 Robinhood 链上一个薄池来定，所以**不索引价格池**，沿用 `CoinPriceService` 那条线，按资产类型分路由。发射的币没有自己的价源，**永远是「以配对资产计的数 × 该配对资产的美元价」**。CMC 整体下线。

## 线一 · PriceSource 按资产路由

```java
interface PriceSource {
    String name();                                              // 落 launchpad_coin_price.source
    Map<String, CoinPriceQuote> fetchSpot(List<QuoteToken> assets);   // 一轮取一批；失败返回空 map，不抛
}
// CoinPriceService.refresh()：按 admin 名单每个资产的 priceSource 分组 → 各源一次调用 → 合并 → 落库
```

admin 的 `chainlinks[chain].tokens[*]` 加 `priceSource` 字段，与已有的 `isStock` 同级，取值即路由：

| 资产 | priceSource | 候选来源 | 说明 |
|---|---|---|---|
| 稳定币 USDG / USDC | `FIXED_1` | 常量 1 | 不发请求 |
| 原生 ETH / WETH / cbBTC | `EXCHANGE` | 交易所公开行情 ETHUSDT / BTCUSDT | 币安拒美区 IP（dev / test 在俄亥俄取不到，prod 东京可用），备选 Coinbase `ETH-USD`。**具体选哪家待定**，按 profile 定死一家，不做故障切换。`BinanceCoinPriceSource` 在 `backup/dev-before-cmc-refactor-20260910` 分支里 |
| 股票代币 NVDA / AAPL / TSLA | `RH_STOCK` | Robinhood `GET /rhj/prices/{symbol}` bid / ask 中间价 × `/assets` 的 `currentMultiplier` | `isTradingHalt` 为真给 null；`deployments[]` 里 4663 的合约地址与名单按地址对上 |
| 链上有 Chainlink 喂价的 | `CHAINLINK` | 让 Envio 顺手订阅 `AnswerUpdated` 发消息 | 可选；不引入 Java 侧 RPC |
| 没配的 | `NONE` | — | USD 字段一律 null，前端显示「—」。**不猜、不回落、来源之间不互相兜底** |

频率每分钟；**每分钟一行**，六个资产一年约三百万行；原生币与 WETH 同价，各落一行。

## 历史价：成交 handler 与定时线共用的一张表

`launchpad_coin_price` 就是价格历史。**成交 handler 按区块时间读它**给每笔成交、每个桶固化 USD；线二读最新一行算现价类 USD。

```java
// CoinPriceService
Optional<BigDecimal> priceAt(String asset, long blockTimeMillis);   // priced_at ≤ blockTime 的最近一行；距离 > 60 分钟返回 empty
Optional<BigDecimal> currentPrice(String asset);                    // 最新一行；超过 stale-after 返回 empty
```

::: tip USD 在写入时固化，但必须按区块时间取价
消费跟着链头跑时，「≤ 区块时间的最近一行」拿到的就是最新一行，等价于实时价。差别只在三种情况出现：首次上线回填历史、停机后追消息、回放。这时候拿今天的 ETH 价乘上周的成交是错的。所以**价格历史表是固化 USD 的前提**，「实时价」只是它的最新一行。

找不到价格行（只在线一停机窗口发生）：前一行距离超过一小时就写 null，K 线画断点，与协议数据页缺数据的处理一致。**不猜、不回落、不事后补。**
:::

## 每个 USD 数字取价的时点

| 数字 | 乘的是哪个价 | 谁算 |
|---|---|---|
| 现价、市值、流动性 | 配对资产**现价** | 线二，每分钟 UPDATE 全表 |
| 24h 成交额 | 成交表里已固化的 `amount_usd` 求和 | 线三 |
| K 线每个点、成交每一行、Activity 每一行、持仓成本 | 该笔**区块时间**的价 | 成交 handler |
| 协议日成交额 | 每笔成交各自区块时间的价累加 | 成交 handler 写 `launchpad_protocol_day` |

## 两条规则

::: warning
**历史价只来自我们自己每分钟落的行**，不依赖任何历史价 API。历史从开始轮询那天起才有，停机期间的空档给 null，不补。

**每种资产只有一个价源，不互相兜底。** 交易所挂了只影响 ETH 系资产，Robinhood 挂了只影响股票代币，各自 null。
:::
