---
title: 11 · 与扫链现状的差距
---

# 与扫链现状的差距

对照扫链的 `envio/docs/*.md`（`de9ac1b`，09-19）与 dev Kafka 上实抓的 4498 条消息（09-20，用合约公式逐笔复算过）。字段含义见[第 4 页](/messages)。

**结论：发币 / 买 / 卖三种消息的字段够用了，字段名以扫链为准。但有一个 bug 必须先修，修好之前不能联调。**

## 要修的

### 1.【阻塞】同一个 `eventId` 会先发一份错值

**不是历史消息污染，换 topic 解决不了，必须改代码。** 下面是同一次运行（中途没有重启）里同一枚币连续三笔成交，每笔的两份相隔不到 1 秒：

| Kafka 时间 | 事件 | 本笔变动 | `realQuoteReserve` |
|---|---|---|---|
| 12:07:13.590 | CurveBuy | +29400000 | 29400000（只发了一份，对） |
| 12:07:13.590 | CurveSell | −61144 | **−61144**（错） |
| 12:07:14.565 | 同一笔 CurveSell | −61144 | **29338856**（对） |
| 12:07:13.591 | CurveBuy | +24500000 | **24500000**（错） |
| 12:07:14.566 | 同一笔 CurveBuy | +24500000 | **53838856**（对） |

先到的那份 = 「批次起点的储备 ± 本笔」，前面的成交像没发生过；后到的那份才是累加过的。

**原因**：Envio 每一批事件的 handler 跑两遍。

1. **preload**：这一批的事件并行跑一遍。这一遍里 `context.Curve.set()` 不生效，`get()` 读到的都是这一批开始之前的状态。
2. **正式处理**：按链上顺序逐条跑，前一条 `set` 的后一条能读到——累加在这一遍才成立。

handler 是「读 Curve → 加上本笔 → `set` → 发 Kafka」，两遍都会走到「发 Kafka」，所以 preload 那遍把用旧储备算出来的值也发了出去。

**触发条件是「同一批里同一枚币有两笔以上成交」**，所以不只是回补历史时才有：回补时一批几千个事件，几乎每枚币都中；实时运行时一批很小，大多数成交只发一份且是对的，看起来像好了——但热门币同一个区块里两笔、或扫链落后追块时，第二笔起就会先发一份错值。也就是平时看不出来，恰好在成交最密集的时候出错。

影响面（一轮完整同步的统计）：

- 一轮同步 2163 条消息，只有 1198 个不同的 `eventId`，同 id 各份内容不同。
- 只看**先到**的那份：978 笔成交里 704 笔储备是错的，出现负数（上表的币是 `0xc853740d…6232d`，区块 119942070 起）。
- 只看**后到**的那份：全部满足合约的常数乘积公式——累加逻辑本身是对的。
- Java 按 `eventId` 去重、先到的赢，落库的正好是错的那份。

**改法**：preload 那遍只读数据、不发 Kafka，只在正式那遍发。

```ts
if (context.isPreload) return;   // 放在 context.effect(publishKafka, …) 之前
```

修完换一个新 topic 重发，旧 topic 我们不再读。

### 2. 回购会让储备漂移（上线前修）

合约回购时直接改储备（`BondingCurve._sweepFees`：`trackedNetQuote += buybackSpent`、`trackedTokens -= tokensLocked`），只发 `BuybackLocked`，不发 `CurveBuy`；扫链没订阅它。开了回购的币，回购一次之后价与毕业进度就一直错。dev 上还没有币开回购，所以数据里没出现。

**改法**：订阅 `BuybackLocked`，在 handler 里同样累加 Curve 实体。这个事件不用发给我们。

### 3. 同一个 `eventId` 的内容不能变

消息形状一变就换 topic 重发，不要在同一个 topic 里用旧 id 发新内容——后到的会被我们当重复丢掉。

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
