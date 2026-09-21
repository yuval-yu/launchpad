---
title: 11 · 与扫链现状的差距
---

# 与扫链现状的差距

对照扫链仓库 `envio` 的 `dev` 分支 `f8ba507`（09-21）：`schema.graphql`、`src/handlers/*`、`config.yaml`、`docs/*.md`；
以及 dev Kafka 上 09-21 20:25 清空重发之后的**整个 topic**（371 条，全部读过：没有重复的 `eventId`，全部按链上顺序到达）。
字段含义见[第 4 页](/messages)。

**一句话：上一版要的东西基本都到位了，曲线、毕业、池内成交、转账都能联调。还剩一个上主网前必须修的风险（野池能把索引器卡死）、
两处我们这边的变更（余额改由 Java 算，Transfer 可以瘦身；**Heartbeat 不要了**）、一件没定的（确认深度）。**

## 已经到位的

| 上一版提的 | 现状 |
|---|---|
| 【原阻塞】同一个 `eventId` 先发一份错值（preload） | **已修，实抓核实**：全部发送点都在 `context.isPreload` 之后；371 条里没有重复 id，曲线储备逐笔连续 |
| 回购让储备漂移 | 已修：订阅了 `BuybackLocked` 并累加 Curve 实体，不发给我们 |
| 换 topic | 旧消息已清空、从头重发，等效。规则不变：**同一个 `eventId` 的内容不能变**，消息形状再变时请清空或换 topic，并告诉我们一声 |
| Swap | 已发，只发官方池（`poolId` 匹配），`side` / 两侧数量 / `priceQuote`（30 位）/ `liquidityQuote` / `trader`（收据净流量，一步到位）都有，不带 USD |
| `priceQuote` 精度、配对资产精度读不到不当 18 | 已修：除法精度 40 位且先乘后除；`decimals()` 读不到直接抛错重试 |
| Transfer | 已发，带 `fromKind` / `toKind`；铸币那一笔不发、曲线初始余额在 TokenLaunched 里建；`Approval` 订阅已去掉 |
| LaunchGraduated 的 `derived` | 已有 `poolId` / `priceQuote` / `liquidityQuote`。实抓确认了同一笔交易里的日志顺序：PoolRegistered → Initialize → ModifyLiquidity → LaunchGraduated，所以处理到它时池已经建好、TVL 已经加上 |
| LaunchGraduationRescued、PoolRegistered 的文档 | 都有了 |

## 【上主网前必须修】野池能把索引器卡死

**野池** = 别人拿我们的币另建的 v4 池（建池无许可，见[第 12 页](/wild-pools)）。现在的处理是：Initialize / ModifyLiquidity / Swap 只要一侧是发射币就收进实体，
只是不发 Kafka。问题出在 `initialize.ts`：野池通过 `isLaunchedToken` 过滤之后，会对**另一侧的代币**调 `getTokenMetadata`；
而上一版按我们的要求改成了「`decimals()` 读不到就抛错重试」。两件事叠在一起：

> 任何人拿一个 `decimals()` 会 revert 的合约和我们的任意一个币建一个野池 → Initialize handler 永远抛错 → 整个索引器停在那个区块，**所有币的消息都断**。成本是一笔建池交易。

**改法**：在 Initialize handler 最前面加一条，池的 Hook 不是我们的就直接不收：

```ts
if (event.params.hooks.toLowerCase() !== GRADUATED_POOL_HOOK) return;   // 放在 getTokenMetadata 之前
```

官方池只可能由我们的 `V4GraduationReceiver` 用这个 Hook 建出来（别人调用会 `UnauthorizedPoolInitializer`），所以这个判据是可靠的。
野池的 Pool 实体不建，后面的 Swap / ModifyLiquidity 在 `if (!pool) return` 自然跳过，野池带来的 RPC 与计算也一并省掉。
**Transfer 不受影响**：野池里的买卖照样以「PoolManager ↔ 用户」的转账发给我们，余额不分池，这正是我们要的。

## 变更：余额改由我们算，Transfer 可以瘦身

09-21 定：**变动后的余额、总供应、正余额地址数由 Java 从 Transfer 累加**，不再需要你给。Transfer 消息可以只留：

```json
"payload": {
  "address": "0x3d7e…4cdd",
  "args": { "from": "0x73d4…31eb", "to": "0x2bf5…7675", "value": "714285714285714285714285715" },
  "token": { "token": "0x3d7e…4cdd" },
  "derived": { "fromKind": "CURVE", "toKind": "USER" }
}
```

- `derived.fromBalance` / `toBalance` / `totalSupply` / `positiveBalanceCount` **可以删**（`TokenBalance` 实体、`Token.currentTotalSupply` / `positiveBalanceCount` 你想留就留，我们不读）。现在带着也无害，我们不读它们。
- `derived.fromKind` / `toKind` **请保留**，它们是必须字段：哪个地址是路由、金库、池子是链上语义，缺了我们这边这条消息会直接失败（不会悄悄当成 `USER`——那会让 PoolManager 排上持有者榜第一名）。Hook 归在 `RECEIVER` 没问题，我们只区分「用户 / 曲线 / 其它合约」。
- 顺带一个你自己的性能点：`transfer.ts` 每条 Transfer 都按交易哈希做两次 `getWhere`（查 Swap、查 CurveTrade）只为给实体补关联，这比余额累加更可能是慢的地方。

**这个变更带来一条硬前提：每个币的 Transfer 必须从发币那个区块起一条不漏。** 以前消息里是绝对值，漏一条下一条就盖对了；现在是累加，漏一条那两个地址的余额就一直错，直到补发。
重复、乱序都没关系（我们按 `(txHash, logIndex)` 去重，加减可交换），所以**补发是安全的**，缺哪段重发哪段即可。
发币在 `start_block` 之前的币整个不收是自洽的；要避免的是「币收了、中间的转账缺一段」。
我们在生产上会开一个校正任务，拿链上的 `balanceOf` 核对并改回来，每次改动都会留一条记录（哪个币、哪个地址、差多少）——出现了我们会拿着它来找你查漏发；dev / test 上**不开**，就是为了先看清楚会不会漏。

我们用这次实抓做了对账：Java 累加出来的每个地址的余额、每个币的总供应与正余额地址数，和你消息里算的 181 条逐个相等。

## 还没定的、以及不用做的

### ~~Heartbeat~~ —— 不需要了（09-21）

上一版请你每分钟发一条进度消息。**现在不用做**：它不影响我们任何数据的正确性；我们原本拿它当资产页余额的「同步时间」，
但余额表已经改由 Java 自己累加，同步时间取我们自己的消费水位更准（Heartbeat 和事件消息不在同一个分区，你说「处理到 X」的时候我们可能还没消费完 X−1 的 Transfer）。

**相应地，「扫链停了」这件事我们这边发现不了**——没有消息时，我们分不清是市场安静还是 Envio 挂了。请你那边自己监控进程与同步进度（落后链头多少块）。
Envio 停了不会让我们丢数据（重启后从检查点补发，我们按 `(txHash, logIndex)` / `eventId` 去重），只是停着的那段时间所有页面的数据都是旧的。

### 确认深度与链重组

`removed` 恒为 `false`，`config.yaml` 里没有回滚或确认块数的配置。链重组时 Envio 会回滚自己的实体，但已经发出去的 Kafka 消息收不回来，
重组后的新消息区块哈希不同、`eventId` 也不同，我们会当成两条记两次。请定一个确认深度 N（落后链头 N 个块再发），或者告诉我们这条链（Arbitrum Orbit）上你观察到的重组情况。

### `start_block` 改成了 121977170

工厂地址没变（`0xb872…ed9e`），起始块从 121966229 挪到了 121977170，中间发的币会整个不收。如果是有意跳过旧测试币就没事，确认一下即可。

## 文档上的小问题

| 位置 | 问题 |
|---|---|
| `swap.md` 的 `trader` | 写的是「无法唯一识别时为 `null`」，代码是取净流量最大的地址、没有候选才 `null`。以代码为准即可，请改一下文档 |
| `swap.md` / `initialize.md` / `modify-liquidity.md` 的示例 | 示例里 `tick` / `fee` / `tickSpacing` 是 JSON number，实抓里是字符串（`"tick": "379030"`）。我们不读这几个字段，只是文档与实际不一致 |
| `launch-graduated.md` | 只有 `derived` 片段，没有带 `args` 的完整 payload。实抓里有一条，可以直接贴上去 |

## 已经对齐的

| 项 | 怎么定的 |
|---|---|
| topic / key | `launchpad.chain.events`，key = 币地址 |
| 信封 | 字段齐；四个数值字段是 JSON number，Java 两种都收；`txFrom` 不要了 |
| 认币 | 读 `payload.token.token`；TokenLaunched / LaunchGraduated / PoolRegistered / LaunchGraduationRescued 没有这个容器，读 `args.token` |
| 发币的阈值、初始虚拟储备 | 读 `payload.curve.graduationQuoteThreshold` / `initialVirtualQuoteReserve` |
| 净募集 | 读 `payload.curve.realQuoteReserve` |
| 曲线阶段的币价 | 扫链不给现成的价，**Java 算**：`virtualQuoteReserve ÷ virtualTokenReserve` |
| 曲线成交的交易者 | `derived.trader` 可选，没给取 `recipient` / `seller` |
| 毕业 | 认 `LaunchGraduated`（原设计是 `V4PoolGraduated`，你订阅的是同一笔交易里的这个，我们这边改了）；`PoolRegistered` 兜底补池 id |
| 野池 | Swap 只发官方池；Transfer 不分池全发。野池里的成交在我们这边等同转入 / 转出：只改余额，不进成交、活动与持仓成本 |
| 美元数 | 全部由 Java 按区块时间取价算，消息里不带任何 USD 字段 |
| 多发的事件 | `Initialize` / `ModifyLiquidity` / `BuybackEnabledUpdated` / `CurveBuyRefunded` / `AutoGraduationFailed`：Java 无 handler，落审计后跳过，无害 |

## 顺序

1. **野池卡死**（Initialize 按 Hook 过滤）—— 上主网前必须
2. 确认深度；你那边对 Envio 进程与同步进度的监控
3. Transfer 瘦身、文档小问题 —— 不急，什么时候改都行（瘦身属于消息形状变化，改的时候清一次 topic）
