---
title: 11 · 与扫链现状的差距
---

# 与扫链现状的差距

对照扫链仓库 `envio` 的 `dev` 分支 `4748f51`（09-21）：`schema.graphql`、`src/handlers/*`、`config.yaml`、`docs/*.md`。
曲线部分另有 dev Kafka 上实抓的 4498 条消息（09-20，用合约公式逐笔复算过）。字段含义见[第 4 页](/messages)。

**一句话：schema 里的数据离我们要的不远——Swap 要的数几乎都已经算出来了，只是还没发 Kafka；Transfer 缺一个余额实体；
另外 09-20 提的 preload 重复发错值还没修，它仍然阻塞联调。**

## 总览：schema 里的实体，我们用哪些

我们只消费 Kafka，不查 GraphQL / Postgres。所以下表的「用」= 需要它的字段出现在某条 Kafka 消息里。

| 实体 | 我们用不用 | 说明 |
|---|---|---|
| `Curve` | **用，已经够了** | 已经通过 `payload.curve` 发给我们（发币两个参数、买 / 卖 / 关闭后的储备） |
| `Token`（发币字段） | **用，已经够了** | 通过 TokenLaunched 的 `args` 拿到；`poolId` 通过 PoolRegistered 拿到 |
| `Swap` | **用，不够** | 缺方向、本币 / 配对资产数量、成交后的价、流动性、交易者；**整个事件还没发 Kafka**。见下文 |
| `Pool` | 间接用 | 我们不要 Pool 这张表，但 Swap 消息里的价和流动性要从它取（`token0Price` / `token1Price`、`totalValueLockedToken0` / `1`） |
| `Transfer` | **用，不够** | 只有 `from` / `to` / `value`，缺变动后余额、地址类别、总供应、持有地址数；**整个事件还没发 Kafka**。见下文 |
| `CurveTrade` | 不用 | 曲线成交我们从 CurveBuy / CurveSell 消息自己落，不需要这张表 |
| `Account` `Bundle` `Tick` `ModifyLiquidity` | 不用 | — |
| `Token` 的 `volume*` `feesUSD` `totalValueLocked*` `derivedETH` `txCount` `poolCount`、`Swap.amountUSD`、`Pool` 的各 USD 列 | **不用，也请不要发** | 原因见下面「美元数为什么不用你那套」 |

**schema 里还没有、需要新增的**：

| 缺什么 | 给谁用 |
|---|---|
| 余额实体（币 × 持有地址 → 余额） | Transfer 的 `fromBalance` / `toBalance` |
| `Token` 上的「当前总供应（最小单位）」与「余额 > 0 的地址数」 | Transfer 的 `totalSupply` / `positiveBalanceCount`。现有 `Token.totalSupply` 是发币时写死的整枚 10 亿，销毁后不变，不能用 |
| 协议地址表（Receiver / Locker / Router / 回购金库…） | Transfer 的 `fromKind` / `toKind`。工厂、Hook、PoolManager、各币的曲线你已经有了 |
| 扫链进度（链头、已处理区块） | Heartbeat |

### 美元数为什么不用你那套

`swap.ts` / `initialize.ts` / `modifyLiquidity.ts` 连同 USD 的算法是从 Uniswap v4 subgraph 搬来的：用链上 ETH/USDG 池的价当 ETH 的美元价
（`Bundle.ethPriceUSD`），每个币再通过它所在的池折成 ETH（`findNativePerToken` → `derivedETH`），两者相乘得到各个 USD 列。
这套对一个通用的 DEX 看板是合适的，但覆盖不了发射台要的场景：

| 场景 | 你那套能不能给出美元数 | 原因 |
|---|---|---|
| **曲线阶段**（大部分币一辈子都在这个阶段） | **不能** | 曲线 handler 不算 USD，`Curve` / `CurveTrade` 没有 USD 列，`Token.volumeUSD` 只在 `swap.ts` 里累加；而且 `findNativePerToken` 只在 Pool 实体里找价，曲线阶段没有池，`derivedETH` = 0 |
| 毕业后，配对资产是 ETH / WETH / USDG | 能，但有门槛 | 池里配对资产一侧不足 `minimumNativeLocked`（配的是 1 ETH）就不给价；价来自测试网上很浅的 ETH/USDG 池，一笔 swap 就能拉歪 |
| 毕业后，配对资产是股票代币等其它资产 | **不能** | `chains.ts` 的 `whitelistTokens` / `stablecoinAddresses` 只有 ETH、WETH、USDG，其它配对资产的 `derivedETH` = 0，连带整个池的 USD 都是 0。我们的配对资产名单由运营维护，会不断增加 |

所以美元数全部由 Java 算：每分钟从交易所 / 券商行情给**名单里每一个配对资产**落一行美元价（稳定币恒为 1），每笔成交按它的**区块时间**取那一行价、
写下就不再改。曲线阶段与毕业后是同一条路，配对资产是什么都一样。

这对你意味着两件事：

- **消息里不要带任何 USD 字段**（`amountUSD`、`volumeUSD`、`totalValueLockedUSD`、`derivedETH`、`ethPriceUSD`…）。带了就会出现同一笔成交两个美元数，要解释以谁为准。
- **我们只要以币计的数**：两侧的数量、`priceQuote`（一枚本币值多少**配对资产**）、`liquidityQuote`（以**配对资产**计）。这几个只用到 `sqrtPriceX96`、
  两侧精度和 Pool 上以币计的 TVL，不经过白名单，对任何配对资产都成立——**新增配对资产时你不需要改任何配置**。
  USD 那套你自己留着用不影响我们。

## 先修的三件事（09-20 提过，`4748f51` 核对仍未修）

### 1.【阻塞】同一个 `eventId` 会先发一份错值

**不是历史消息污染，换 topic 解决不了，必须改代码。** 下面是同一次运行（中途没有重启）里同一枚币连续三笔成交，每笔的两份相隔不到 1 秒：

| Kafka 时间 | 事件 | 本笔变动 | `realQuoteReserve` |
|---|---|---|---|
| 12:07:13.590 | CurveBuy | +29400000 | 29400000（只发了一份，对） |
| 12:07:13.590 | CurveSell | −61144 | **−61144**（错） |
| 12:07:14.565 | 同一笔 CurveSell | −61144 | **29338856**（对） |
| 12:07:13.591 | CurveBuy | +24500000 | **24500000**（错） |
| 12:07:14.566 | 同一笔 CurveBuy | +24500000 | **53838856**（对） |

**原因**：Envio 每一批事件的 handler 跑两遍——preload（并行，`set` 不生效，`get` 读到的是这一批之前的状态）和正式处理（按链上顺序，
累加在这一遍才成立）。handler 是「读 Curve → 加上本笔 → `set` → 发 Kafka」，两遍都会走到「发 Kafka」。

**触发条件是「同一批里同一枚币有两笔以上成交」**：回补历史时几乎每枚币都中；实时运行时大多数成交只发一份且是对的，看起来像好了，
但热门币同一区块两笔、或扫链落后追块时，第二笔起就会先发一份错值——恰好在成交最密集的时候出错。
一轮完整同步 2163 条消息只有 1198 个不同的 `eventId`；只看先到的那份，978 笔成交里 704 笔储备是错的。
Java 按 `eventId` 去重、先到的赢，落库的正好是错的那份。

**改法**：你在 `swap.ts:79`、`initialize.ts:177`、`modifyLiquidity.ts:48` 已经用了同一个写法，发 Kafka 的 8 处还没加：

```ts
if (context.isPreload) return;   // 放在每一处 context.effect(publishKafka, …) 之前
```

`BondingCurve.ts` 第 27 / 84 / 104 / 135 / 197 行、`LaunchFactory.ts` 第 26 / 120 行、`GraduatedPoolHook.ts` 第 23 行。
后面新增的 Swap / Transfer 等发送点同样要在这一行之后。

### 2. 回购会让储备漂移（上线前修）

合约回购时直接改储备（`BondingCurve._sweepFees`：`trackedNetQuote += buybackSpent`、`trackedTokens -= tokensLocked`），只发 `BuybackLocked`，
不发 `CurveBuy`；`config.yaml` 没订阅它。开了回购的币，回购一次之后价与毕业进度就一直错。

**改法**：订阅 `BondingCurve.BuybackLocked(quoteSpent, tokensLocked)`，在 handler 里同样累加 Curve 实体。这个事件不用发给我们。

### 3. 同一个 `eventId` 的内容不能变

消息形状一变就换 topic 重发，不要在同一个 topic 里用旧 id 发新内容——后到的会被我们当重复丢掉。
**这次合约重新部署了（工厂 `0xb872…ed9e`、Hook `0x3037…e044`、起始块 121966229），旧 topic 里混着旧工厂的币，
请在修完第 1 条后直接换一个新 topic 从头发，把名字告诉我们。**

## 要新增的消息

信封、key（= 发射币地址）、`payload.address` / `args` / `token` 的规则与现有四种消息完全一样，下面只写每种消息的 `derived`，
以及它能从你现有代码的哪里取。

### Swap（PoolManager）

你现在的 `swap.ts` 已经把方向以外的数都算出来了，差的是「整理成下面的形状并发出去」。

```json
"payload": {
  "address": "0x8366…0951",
  "args": { "id": "0x1dcf…a049", "sender": "0xrouter…", "amount0": "-2500000000000000", "amount1": "18000000000000000000000",
            "sqrtPriceX96": "…", "liquidity": "…", "tick": "-201234", "fee": "3000" },
  "token": { "token": "0x3d7e…4cdd" },
  "derived": { "side": "BUY", "trader": "0x944…",
               "tokenAmount": "18000000000000000000000", "quoteAmount": "2500000000000000",
               "priceQuote": "0.000000000000138", "liquidityQuote": "9000000000000000000" }
}
```

| 字段 | 从哪取 | 现状 |
|---|---|---|
| `args.*` | `event.params` 原样 | 有 |
| `token.token` | 这个池对应的发射币地址。也是 Kafka key | 有（`token0` / `token1` 里 `isLaunchedToken` 的那个） |
| `derived.side` | 发射币那一侧的 **原始** `event.params.amountX`：`> 0`（swapper 收到本币）= `BUY`，`< 0` = `SELL`。注意你的实体里 `amount0` / `amount1` 是翻过符号的，别用反了 | 要加，一行 |
| `derived.tokenAmount` | 发射币那一侧原始 `amountX` 的绝对值，**最小单位整数串**（不要用换成整枚的 BigDecimal） | 要加，一行 |
| `derived.quoteAmount` | 另一侧原始 `amountX` 的绝对值，最小单位整数串 | 要加，一行 |
| `derived.priceQuote` | 成交后一枚本币值多少配对资产，整枚对整枚的十进制小数串。就是 `swap.ts:83` 的 `prices`：**本币是 token0 → 取 `prices[1]`（`token1Price`）；本币是 token1 → 取 `prices[0]`（`token0Price`）**。名字容易看反：`token1Price` 的意思是「一枚 token0 值多少 token1」 | 值已有，要选对那一个 |
| `derived.liquidityQuote` | 成交后池的流动性，以配对资产计 = 配对资产一侧的 TVL + 本币一侧的 TVL × `priceQuote`，换回配对资产的**最小单位**、向下取整的整数串。两侧 TVL 就是 `swap.ts:126–127` 更新后的 `totalValueLockedToken0` / `1`，口径接受你现在的累加法 | 值已有，要组合一下 |
| `derived.trader` | 真实交易者，认不出给 `null`。见下面单独一节 | **缺，且不好做** |

四个要注意的地方：

1. **只发我们自己的池。** 现在的过滤条件是「两侧至少有一个是发射币」（`swap.ts:40`），别人拿我们的币另建的池也会进来。
   发 Kafka 的条件请收紧为 `发射币.poolId === event.params.id`（`poolId` 由 PoolRegistered 写入）。实体你想怎么存不影响我们。
2. **`priceQuote` 的精度。** 我们按 30 位小数存价。`pricing.ts:24` 是先 `num.div(denom)` 再乘除精度——如果 `BigDecimal` 是 bignumber.js 默认的
   20 位小数，USDG（6 位精度）配对的池在第一步除法就会被截到只剩一两位有效数字（原始比值在 1e-19 量级）。**请确认一下 `BigDecimal` 的小数位设置**；
   保险的写法是先乘 `10^token0Decimals` 再除，或者把除法精度调到 40 位以上。
3. **配对资产的精度读不到时不要当 18。** `tokenMetadata.ts` 在 `decimals()` 调用失败时兜底成 18。配对资产有很多种、精度各不相同（USDG 是 6），
   一旦兜底，`priceQuote` 与 `liquidityQuote` 会差 10¹² 倍，而且没有任何报错，我们收到的就是一个错价。读不到请让 handler 失败重试，不要发出这条消息。
   （曲线阶段的价是 Java 用运营名单里的精度算的，毕业后的价是你用链上读的精度算的，两边必须是同一个数。）
4. **不要带任何 USD 字段**，原因见上文「美元数为什么不用你那套」。

#### `trader` 为什么难、建议怎么做

池内 Swap 的 `sender` 是路由合约，不是人。你现在用 Transfer ↔ Swap 的关联来补这个信息，思路是对的，但**发消息的时候用不上**：
同一笔交易里本币的 Transfer 日志排在 Swap 日志**后面**（先 swap、再 take / settle），处理 Swap 的那一刻这些 Transfer 还没被处理，
你的代码也是靠后到的 handler 回头补关联。Kafka 消息发出去就不能回头补了。

`tx.from` 不能当交易者：我们有 0x gasless 下单，`tx.from` 是中继；以前就出过把中继记成交易者的事故。

建议：在 Swap handler 里用一个带缓存的 effect 取这笔交易的收据（`eth_getTransactionReceipt`），只看 `payload.token.token` 这个币的 Transfer 日志，
按地址算净流量，**剔掉协议地址**（PoolManager、路由、Hook、曲线等，就是下文 Transfer 要用的那张地址表）后：
`BUY` 取净流入最大的地址，`SELL` 取净流出最大的地址；没有候选就给 `null`。

**这一项可以分两步**：第一步先恒发 `null`，我们就能开始联调池内成交、K 线和币价；交易者补上之前，池内成交不会出现在任何人的活动和持仓里，
所以上线前必须有。

### Transfer（LaunchToken）

这是 schema 差得最多的一块：现在的 Transfer 实体只有事件原文，我们要的是**变动之后的绝对值**。
原因：余额我们只 set、不累加，这样消息重复、乱序、回放都不会把余额算错；而「变动后余额」只有按链上顺序处理的你那边能给。

```json
"payload": {
  "address": "0x3d7e…4cdd",
  "args": { "from": "0x73d4…31eb", "to": "0x2bf5…7675", "value": "714285714285714285714285715" },
  "token": { "token": "0x3d7e…4cdd" },
  "derived": { "fromBalance": "285714285714285714285714285", "toBalance": "714285714285714285714285715",
               "fromKind": "CURVE", "toKind": "USER",
               "totalSupply": "1000000000000000000000000000", "positiveBalanceCount": "2" }
}
```

| 字段 | 含义 | 现状 |
|---|---|---|
| `args.from` / `to` / `value` | 原样 | 有 |
| `token.token` | = `payload.address`，和别的消息保持同一个取法 | 有 |
| `derived.fromBalance` / `toBalance` | 这一笔**之后**的余额，最小单位；对应一侧是零地址时给 `null` | **缺**：要新增余额实体，例如 `TokenBalance { id: {chainId}_{token}_{holder}, token, holder, balance: BigInt }` |
| `derived.totalSupply` | 这一笔之后的总供应，最小单位。`to` 为零地址（销毁）时减 | **缺**：`Token` 上加一个最小单位的当前总供应 |
| `derived.positiveBalanceCount` | 这一笔之后余额 > 0 的地址数，含合约、不含零地址。某地址余额 0 → 正 加一，正 → 0 减一 | **缺**：`Token` 上加一个计数 |
| `derived.fromKind` / `toKind` | 地址类别：`USER` / `CURVE` / `POOL_MANAGER` / `FACTORY` / `RECEIVER` / `LOCKER` / `ROUTER` / `VAULT` / `ZERO`；不在地址表里的一律 `USER` | **缺**：`chains.ts` 里加一份协议地址表。对我们最要紧的是 `USER` / `CURVE` / `ZERO` 判对，其余协议合约只要不落进 `USER` 就行 |

三个要注意的地方：

1. **铸币那一笔不发，但要记进你的余额实体。** 铸币的 Transfer 日志排在 TokenLaunched 前面，现在 `transfer.ts:13` 因为 Token 实体还不存在会直接 return——
   不发是对的（我们在收到 TokenLaunched 时自己写曲线的初始余额），但你那边要在 TokenLaunched handler 里把曲线的余额初始化成总量、
   计数置 1、当前总供应置总量，否则第一笔买入算出来的 `fromBalance` 会是负数。
2. `from === to`、`value = 0` 这两种边界不要让计数漂移。
3. `config.yaml` 里 LaunchToken 和 PoolManager 的 `Approval` 订阅没有 handler、量还大，建议去掉。

Transfer 是消息量的大头（一笔经路由的买入带出两条）。同样只在非 preload 那一遍发。

### 毕业：沿用你已经在发的 LaunchGraduated + PoolRegistered

原设计要的是 `V4GraduationReceiver.V4PoolGraduated`，你订阅的是同一笔交易里的 `LaunchFactory.LaunchGraduated`。
**不用改订阅，我们这边改成认 LaunchGraduated。** 只差两个 `derived` 字段，让币在「建池 → 第一笔 Swap」之间也有价：

| 消息 | 现状 | 还差 |
|---|---|---|
| `PoolRegistered` | 在发，`args`（`poolId` / `token` / `quoteAsset`）够用 | 只差 `envio/docs` 里的文档 |
| `LaunchGraduated` | 在发，只有 `args`（`token` / `curve` / `receiver` / `quoteAsset` / `quoteAmount` / `tokenAmount`） | `derived.poolId`、`derived.priceQuote`（池初始价，取法同 Swap）、`derived.liquidityQuote`（取法同 Swap） |

`priceQuote` / `liquidityQuote` 取自 Pool 实体，前提是同一笔交易里 Initialize 与 ModifyLiquidity 的日志排在 LaunchGraduated **前面**
（这样处理到它时 Pool 已经建好、TVL 已经加上）。请在 dev 上找一笔毕业交易确认一下日志顺序；如果顺序不满足，告诉我们，再商量改订 V4PoolGraduated
（它的 `args` 里自带 `sqrtPriceX96` 与两侧数量）。

### LaunchGraduationRescued（LaunchFactory）

ABI 里已经有，`config.yaml` 还没订阅。只要 `args` 原样（`token` / `recipient` / `quoteAmount` / `tokenAmount`），key = `args.token`，
写法和 LaunchGraduated 那个 handler 一样。没有它，被救援的币在我们这边没有终态。

### Heartbeat（不是合约事件）

schema 里没有对应的东西。每分钟左右发一条，让我们分得清「市场安静」和「扫链停了」：

```json
{ "eventId": "v1:46630:heartbeat:121970000", "eventName": "Heartbeat", "chainId": 46630,
  "blockNumber": 121970000, "blockTimestamp": 1789900000, "…": "…",
  "payload": { "derived": { "headBlock": "121970012", "processedBlock": "121970000", "processedBlockTime": "1789900000" } } }
```

`processedBlock` = 已经处理完的区块；`headBlock` = 你看到的链头；信封的 `blockNumber` / `blockTimestamp` 请填**已处理区块**的，不要填发送时间。
key 用任意固定值。取法（block handler、定时器、另查 RPC）归你定。

## 已经对齐的

| 项 | 怎么定的 |
|---|---|
| topic / key | key = 币地址（topic 名这次要换，见上） |
| 信封 | 字段齐；四个数值字段是 JSON number，Java 两种都收；`txFrom` 不要了 |
| 认币 | 只读 `payload.token.token`（TokenLaunched 读 `args.token`） |
| 发币的阈值、初始虚拟储备 | 读 `payload.curve.graduationQuoteThreshold` / `initialVirtualQuoteReserve` |
| 净募集 | 读 `payload.curve.realQuoteReserve` |
| 曲线阶段的币价 | 扫链不给现成的价，**Java 算**：`virtualQuoteReserve ÷ virtualTokenReserve` |
| 曲线成交的交易者 | `derived.trader` 可选，没给取 `recipient` / `seller` |
| 多发的事件 | `CurveBuyRefunded` / `AutoGraduationFailed`，Java 无 handler 直接跳过，无害 |

## 顺序

1. 修「先修的三件事」第 1 条，换新 topic 重发 —— 曲线部分就能联调了
2. **Transfer**（余额实体 + 地址表）—— 解锁余额、持有者、持有人数、持仓数量
3. **Swap**（`trader` 先发 `null`）—— 解锁已毕业币的价、K 线、成交
4. LaunchGraduated 补 `derived`；订阅 LaunchGraduationRescued
5. Swap 的 `trader`（收据净流量）；`BuybackLocked`
6. Heartbeat

每新增一种消息，请在 `envio/docs/` 里补一份和现有几份同样格式的文档，并留一条 dev 上的真实样例——我们的 handler 以真实样例定稿。
