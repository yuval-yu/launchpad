---
title: 11 · 与扫链现状的差距
---

# 与扫链现状的差距

对照对象：扫链同学 2026-09-18 给出的消息定义（`envio/docs/*.md`，提交 `02210c3`），以下称「现状」；我们的需求在[第 4 页](/messages)。结论一句话：**信封基本一致，可以直接接；分区键、事件集合、`derived` 三块是缺口，其中分区键是必须先改的。**

## 一眼看清

| 项 | 现状 | 我们要的 | 差距 | 处理 |
|---|---|---|---|---|
| topic | `launchpad.chain.events` | `launchpad.chain.event` | 名字差一个 s | **接受现状**，文档改成 `launchpad.chain.events` |
| Kafka key | TokenLaunched 用 `args.token`；曲线事件用 `payload.address`（curve 地址） | 一律 token 地址 | **同一个币的发币和成交落在不同分区，顺序不保证** | **必须改**：所有事件 key = token |
| 信封字段 | 有 `eventId` `eventName` `blockNumber` `blockHash` `blockTimestamp` `chainId` `logIndex` `removed` `txHash` `payload.address` `payload.args` | 同左 + `txFrom` + `payload.signature` + `payload.derived` | 缺 `txFrom`、`signature`、`derived` | `txFrom` 加（开 `transaction_fields: [from]`）；`signature` 降为可选；`derived` 见下 |
| 数值类型 | `blockNumber` `blockTimestamp` `chainId` `logIndex` 是 JSON number；`args` 里的整数是十进制字符串 | 全部十进制字符串 | 信封四个字段是 number | **接受现状**，都在安全整数范围内，Java 解析层两种都收 |
| 地址 / 哈希 | `0x` 小写 | 同 | 无 | — |
| `removed` | 「是否因链重组被移除」，语义上可能发 `true` | 恒 `false`，确认深度后才发 | 要不要确认深度没定 | 列入 P0 问清（[第 10 页](/rollout) Q3） |
| `blockTimestamp` | 有，秒 | 必须非 0 | 无 | — |
| 事件集合 | 6 种：TokenLaunched · CurveBuy · CurveSell · CurveCompleted · CurveBuyRefunded · AutoGraduationFailed | 10 种 + Heartbeat | **缺 7 种，多 2 种** | 见下节 |
| `derived` | 没有 | 每种事件都有 | **整段缺失** | 见下节 |

## 事件集合

| 事件 | 现状 | 我们 | 说明 |
|---|---|---|---|
| TokenLaunched | 有 | 要 | args 齐全（17 个参数含 `socials.storyFun`），缺 `derived` |
| CurveBuy | 有 | 要 | args 齐全，缺 `derived` |
| CurveSell | 有 | 要 | 同上 |
| CurveCompleted | 有 | 我们订的是 **LaunchSwept**（同 tx，带 `token`） | 两条二选一即可：用 CurveCompleted 就要在 `derived` 里补 `token`（args 里只有 curve）；用 LaunchSwept 则 args 自带 token。**建议改订 LaunchSwept**，与状态机口径一致 |
| CurveBuyRefunded | 有 | 不要 | 退款不含在 `grossQuoteIn` 里，不影响任何数。多发无害，Java 会 SKIPPED，但白占审计表 |
| AutoGraduationFailed | 有 | 不要 | 排查用，多发无害 |
| **QuoteAssetConfigured** | 无 | 要 | 配对资产精度 / 阈值的链上权威 |
| **V4PoolGraduated** | 无 | 要 | 建池、初始价、`pool_id` |
| **PoolRegistered** | 无 | 要 | poolId 兜底 |
| **LaunchGraduationRescued** | 无 | 要 | 新终态 |
| **Swap** | 无 | 要 | **毕业后成交的唯一来源**，没有它已毕业的币没有价格、K 线、成交记录 |
| **Transfer** | 无 | 要 | **余额、持有者、持有人数的唯一来源** |
| **Heartbeat** | 无 | 要 | 分不清「市场安静」和「Envio 停了」 |

现状只覆盖曲线阶段的发币和买卖，**毕业后整条线（建池、Swap）和持有者线（Transfer）都还没有**。

## 每种事件缺的 derived 字段

现状所有事件都没有 `derived`。按[第 4 页](/messages)逐条列出要补的，含义与理由在那一页，这里只列清单。

### TokenLaunched

| 字段 | 必须 | Envio 怎么得到 |
|---|---|---|
| `derived.quoteDecimals` | ✓ | 按 `quoteConfigHash` 查 QuoteAssetConfig |
| `derived.graduationQuoteThreshold` | ✓ | 同上 |
| `derived.initialVirtualQuoteReserve` | ✓ | 同上 |
| `derived.totalSupply` | ✓ | `LaunchDefaults.TOTAL_SUPPLY` |
| `derived.tokenDecimals` | ✓ | 常数 18 |
| `derived.curveBalance` | ✓ | = totalSupply；替代不发的铸币 Transfer |
| `derived.quoteSymbol` | 可选 | Effect 读 `symbol()`，原生币 `ETH` |

### CurveBuy / CurveSell

| 字段 | 必须 | Envio 怎么得到 |
|---|---|---|
| `derived.token` | ✓ | curve → token 映射 |
| `derived.trader` | ✓ | 名义地址；是合约则按整笔收据本币 Transfer 净流量穿透（[第 3 页](/envio)） |
| `derived.baseFee` `creatorTax` `snipeTax` | ✓ | 按合约 `_splitBuyFees` / 卖出税率拆；snipeTax 来自同 tx `SnipeTaxCharged`（卖出无） |
| `derived.quoteReserve` `tokenReserve` | ✓ | 成交后 `trackedNetQuote` / `trackedTokens` |
| `derived.priceQuote` | ✓ | 常数乘积定价 |
| `derived.liquidityQuote` | ✓ | `trackedNetQuote × 2` |

### Swap（整条缺）

`derived.token` `poolId` `side` `trader` `tokenAmount` `quoteAmount` `priceQuote` `liquidityQuote` `hookFee` `creatorTax` `feeCurrency`，全部必须。

### Transfer（整条缺）

`derived.fromBalance` `toBalance` `fromKind` `toKind` `totalSupply` `positiveBalanceCount`，全部必须；`from == 0x0` 的铸币不发。

### V4PoolGraduated（整条缺）

`derived.priceQuote` `liquidityQuote`。

## 建议：按这个顺序对齐

1. **先改 key。** 所有事件 key = token 地址（curve 事件从内部 `Token.curve` 反查；PoolManager 事件从 poolId 反查）。这一条不改，同一个币的 TokenLaunched 和首买会落到两个分区，Java 收到「币还没到」的成交只能等重投。改动一行，影响最大。
2. **补 `derived.token` 与 `derived.trader`。** 有了 token Java 才能关联；有了 trader Activity 和持仓才有归属。
3. **补 Transfer 与 Swap 两种事件。** 没有前者没有余额和持有者；没有后者已毕业的币是死的。
4. **补 CurveBuy / CurveSell 的其余 derived**（费用拆分、储备、价格、流动性）与 TokenLaunched 的 derived。
5. **补毕业三事件、QuoteAssetConfigured、Heartbeat。**
6. `CurveCompleted` 换成 `LaunchSwept`；`CurveBuyRefunded` / `AutoGraduationFailed` 停发；加 `txFrom`。

第 1、2 条做完 Java 就能开始联调曲线阶段；第 3 条做完才有毕业后与持有者；其余按顺序补。

## 我们这边随之调整的

- topic 名改用现状的 `launchpad.chain.events`
- 信封四个数值字段接受 JSON number（Java 解析层同时接受 number 与十进制字符串）
- `payload.signature` 降为可选
- 多发的 `CurveBuyRefunded` / `AutoGraduationFailed`：Java 无 handler 即 SKIPPED，不报错；但建议停发
