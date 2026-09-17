---
title: 6 · 只需要几个配对资产的价，其余全是乘法
---

# 只需要几个配对资产的价，其余全是乘法

链上只知道「一个币值多少个配对资产」。配对资产是 WETH、USDG、cbBTC 和股票代币这类全球有价的资产，五六个， 它们的美元价不该由 Robinhood 链上一个薄池来定，所以**不索引价格池**，沿用现在 `CoinPriceService` 那条线，按资产类型分路由。 发射的币没有自己的价源，**永远是「以配对资产计的数 × 该配对资产的美元价」**。

## 线一 · 按资产分路由

| 谁 | 怎么定价 |
|---|---|
| 稳定币 | 恒等于 1。admin 的 `quoteTokens` 名单新增 `isStable`，与现有 `isStock` 同级 |
| 原生币 / WETH / cbBTC | 币安公开行情 `GET /api/v3/ticker/price?symbols=["ETHUSDT","BTCUSDT"]`，免费、无 key、一次一个请求。ETH 与 WETH 同用 `ETHUSDT`，cbBTC 用 `BTCUSDT`。这是两条**锚定假设**（WETH ≈ ETH、cbBTC ≈ BTC，实测偏差不到千分之一），运营名单里用 `binanceSymbol` 写明映射。`BinanceCoinPriceSource` 在 `backup/dev-before-cmc-refactor-20260910` 分支里，挑回来即可 |
| 股票代币 | Robinhood 官方 `GET /rhj/prices/{symbol}`：底层股票的 bid / ask 取中间价，**乘 `/assets` 的 `currentMultiplier`** 才是一枚代币的价；`isTradingHalt` 为真给 null；`deployments[]` 里 4663 的合约地址与运营名单按地址对上。发行方自己的报价。链上若有 Chainlink 喂价，也可以让 Envio 顺手索引 `AnswerUpdated` |
| 发射的币 | **不需要找池子**：`lastPriceQuote × 配对资产美元价`。曲线每笔成交直接给出了价；毕业后池子仍是「该币 ↔ 它的配对资产」，按 `Pool.quoteToken` 认，不默认等于发币时的 |
| 没有定价路径的 | USD 字段一律 null，前端显示「—」。**不猜、不回落、来源之间不互相兜底** |

admin 名单每个资产加 `priceSource`（STABLE / BINANCE / ROBINHOOD）与对应的交易对或 symbol。频率每分钟；落库**每分钟一行，另落小时行**，六个资产一年不到三百万行。可选同步写一份 Redis sorted set 给 Envio 的 Effect 读，MySQL 是源。

::: warning 币安对美国 IP 返回 451
prod 在东京可用；dev / test 在俄亥俄取不到价。dev / test 要么接受 USD 为 null，要么改用同样免费的 Coinbase 公开行情 `ETH-USD` / `BTC-USD`，按 profile 定死一家，**不做故障切换**。
:::

## 历史价：Envio 与 Java 共用的一张表

`launchpad_coin_price` 就是价格历史。**Envio 的取价 Effect 按区块时间读它**给成交和桶写 USD；Java 线二读最新一行算现价类 USD。

::: tip USD 在索引时固化，但必须按区块时间取价
indexer 跟着链头跑时，「按区块时间取最近一行」拿到的就是最新一行，等价于实时价。 差别只在三种情况出现：首次同步灌历史、停机后追块、改 handler 重跑。这时候拿今天的 ETH 价乘上周的成交是错的， 「重跑结果与增量跑一致」这条纪律就破了。所以**价格历史表是固化 USD 的前提**，「实时价」只是它的最新一行。Effect 的缓存键是（资产，分钟），重跑时直接命中，连 MySQL 都不用再查。

找不到价格行（只在线一停机窗口发生）：前一行距离超过一小时就写 null，前端画断点，和协议数据页缺快照的处理一致。**不猜、不回落、不事后补。**
:::

## 每个 USD 数字取价的时点

| 数字 | 乘的是哪个价 | 谁算 | 为什么 |
|---|---|---|---|
| 现价、市值、流动性 | 配对资产**现价** | Java 线二，每分钟 UPDATE 全表 | 排序要基于同一个最新基准，ETH 一动全表都变 |
| 24h 成交额 | 桶里已固化的 USD 求和 | Java 线三 | 与 K 线同一个数 |
| K 线每个点、成交每一行、Activity 每一行 | 该桶 / 该笔**区块时间**的价 | Envio handler | 90 天里 ETH 能差 30%，用今天的价折整条线就是错的 |
| 协议日成交额 | 每笔成交各自区块时间的价累加 | Envio handler | 昨天的数不能随今天的价漂 |

## 两条规则

::: warning
**历史价只来自我们自己每分钟落的行**，不依赖任何历史价 API。历史从开始轮询那天起才有，停机期间的空档给 null，不补。

**每种资产只有一个价源，不互相兜底。** 币安挂了只影响 ETH 系资产，Robinhood 挂了只影响股票代币，各自 null。
:::
