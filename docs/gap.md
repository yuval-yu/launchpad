---
title: 11 · 与扫链现状的差距
---

# 与扫链现状的差距

对照扫链的 `envio/docs/*.md`（`de9ac1b`，09-19）与 dev Kafka 上实抓的 4498 条消息（09-20，用合约公式逐笔复算过）。字段含义见[第 4 页](/messages)。

**结论：发币 / 买 / 卖三种消息的字段够用了，字段名以扫链为准。但有一个 bug 必须先修，修好之前不能联调。**

## 要修的

### 1.【阻塞】同一个 `eventId` 会先发一份错值

Envio 的 handler 每批跑两遍（先 preload、再正式处理），现在两遍都在发 Kafka。preload 那遍读不到同批次前面事件写的 Curve，储备是错的。

- 一轮同步 2163 条消息，只有 1198 个不同的 `eventId`，同 id 各份内容不同。
- 只看**先到**的那份：978 笔成交里 704 笔储备是错的，出现负数。例：币 `0xc853740d…6232d`、区块 119942114 的 `CurveSell`，先到的 `realQuoteReserve = "-61144"`，后到的 `"29338856"`。
- 只看**后到**的那份：全部满足合约的常数乘积公式——累加逻辑本身是对的。
- Java 按 `eventId` 去重、先到的赢，落库的正好是错的那份。

**改法**：发 Kafka 前判断 preload。

```ts
if (context.isPreload) return;   // 放在 context.effect(publishKafka, …) 之前
```

修完换一个新 topic 重发，旧 topic 我们不再读。

### 2. 回购会让储备漂移（上线前修）

合约回购时直接改储备（`BondingCurve._sweepFees`：`trackedNetQuote += buybackSpent`、`trackedTokens -= tokensLocked`），只发 `BuybackLocked`，不发 `CurveBuy`；扫链没订阅它。开了回购的币，回购一次之后价与毕业进度就一直错。dev 上还没有币开回购，所以数据里没出现。

**改法**：订阅 `BuybackLocked`，在 handler 里同样累加 Curve 实体。这个事件不用发给我们。

### 3. 同一个 `eventId` 的内容不能变

消息形状一变就换 topic 重发，不要在同一个 topic 里用旧 id 发新内容——后到的会被我们当重复丢掉。

### 4. 补 `txFrom`

`config.yaml` 的 `transaction_fields` 加 `from`。不阻塞。

## 已经对齐的

| 项 | 怎么定的 |
|---|---|
| topic / key | `launchpad.chain.events`，key = 币地址 |
| 信封 | 字段齐；四个数值字段是 JSON number，Java 两种都收 |
| 认币 | 只读 `payload.token.token` |
| 发币的阈值、初始虚拟储备 | 读 `payload.curve.graduationQuoteThreshold` / `initialVirtualQuoteReserve` |
| 净募集 | 读 `payload.curve.realQuoteReserve` |
| 币价 | 扫链不给现成的价，**Java 算**：`virtualQuoteReserve ÷ virtualTokenReserve`，再按两侧精度换算 |
| 交易者 | `derived.trader` 可选，没给取 `recipient` / `seller` |
| 多发的事件 | `CurveBuyRefunded` / `AutoGraduationFailed` / `LaunchGraduated`，Java 无 handler 直接跳过，无害 |

## 还缺的

| 事件 | 没有它会怎样 | 要带的字段 |
|---|---|---|
| **Swap** | 已毕业的币没有价、K 线、成交 | `derived.side` `trader` `tokenAmount` `quoteAmount` `priceQuote` `liquidityQuote` |
| **Transfer** | 没有余额、持有者、持有人数 | `derived.fromBalance` `toBalance` `fromKind` `toKind` `totalSupply` `positiveBalanceCount`；铸币那笔不发 |
| **V4PoolGraduated** | 毕业到第一笔 Swap 之间没有价 | `derived.priceQuote` `liquidityQuote` |
| **PoolRegistered** | 代码里已在发，只带 args，缺文档 | — |
| **LaunchGraduationRescued** | 被救援的币没有终态 | — |
| **Heartbeat** | 分不清「市场安静」和「扫链停了」 | `derived.headBlock` `processedBlock` `processedBlockTime` |

顺序：先修上面第 1 条 → Transfer 与 Swap → 其余。
