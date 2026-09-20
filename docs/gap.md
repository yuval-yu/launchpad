---
title: 11 · 与扫链现状的差距
---

# 与扫链现状的差距

对照对象：扫链同学给出的消息定义（`envio/docs/*.md`，最新提交 `de9ac1b`「增加参数」，2026-09-19），以下称「现状」；我们的需求在[第 4 页](/messages)。**2026-09-20 更新**：除了读文档，这次还从 dev Kafka 只读实抓了 `launchpad.chain.events` 上的全部 4498 条消息，用合约的常数乘积公式逐笔复算过。

结论一句话：**曲线阶段（发币 / 买 / 卖）的字段已经够用，字段名与容器以扫链为准、我们不再要求改名；但消息的发送方式有一个必须先修的 bug（同一个 `eventId` 先发一份错值），修好之前不能联调。** 毕业后（Swap、建池）与持有者（Transfer）两条线仍然没有。

## 需要扫链修的（09-20，按优先级）

### 1. 【阻塞】Kafka 消息在 Envio 的 preload 阶段就发出去了：同一个 `eventId` 先到一份错值

**现象**（dev Kafka 实抓，一轮完整同步 = offset 12620..14782）：

- 2163 条消息只有 1198 个不同的 `eventId`：755 个发了 2 份、105 个发了 3 份。
- 同 id 的各份**内容不一样**。只取先到的那份：978 笔成交里 **704 笔的储备是错的**；只取后到的那份：除 2 笔毕业封顶买入（公式本来就不适用，净募集正好等于阈值）外**全部满足合约公式**。
- 错的那份，每笔成交的 `realQuoteReserve` 都等于「这一批开始时的值 ± 本笔」，累加没生效。例：币 `0xc853740db57e84e50a58c730a8571bf45c06232d`，区块 119942114 的 `CurveSell`，先到的一份 `realQuoteReserve = "-61144"`（负数），后到的一份是 `"29338856"`。
- 顺序也被打乱：币 `0x271688f25e5befa216b3b81ca90986cb0c5ace27` 的 `PoolRegistered` / `LaunchGraduated`（区块 121046587，offset 14555–14556）排在它更早区块的成交（区块 121040681 起，offset 14557 之后的 100 多条）**前面**。

**原因**（按实抓数据与 Envio 的双跑机制推断，请扫链同学确认）：Envio 的 handler 每批跑两遍——先并行的 preload，再顺序的正式处理。`publishKafka` 这个 effect 两遍都会执行。preload 那遍 `context.Curve.get()` 读不到同批次前面事件 `set` 的值，所以储备是批次起点的值；正式那遍因为 effect 的入参（消息内容）变了，缓存不命中，又发了一遍对的。不带储备的消息（`PoolRegistered` 等）两遍内容相同，第二遍被 effect 去重省掉，于是只剩 preload 时抢先发出的那一份——这就是顺序错乱的来源。

**为什么对我们是阻塞**：Java 审计表按 `eventId` 去重、**先到的赢**，留下来的正好是错的那份。

**建议改法**：每个 handler 里发 Kafka 之前判断 preload，只在正式那遍发：

```ts
if (context.isPreload) return;   // 放在 context.effect(publishKafka, …) 之前，实体的 get / set 之后
```

（`context.isPreload` 见仓库自带的 `.claude/skills/indexer-handlers/SKILL.md`。）修完之后请换一个新 topic 重发，旧 topic 上的数据我们不再读。

### 2. 回购会让累加的储备漂移（现在没触发，上线前要修）

合约 `BondingCurve._sweepFees` 在回购时会直接改定价储备：`trackedNetQuote += buybackSpent`、`trackedTokens -= tokensLocked`（`BondingCurve.sol` 约 703–728 行），只发 `BuybackLocked(buybackSpent, tokensLocked)`，**不发 `CurveBuy`**。`config.yaml` 里 BondingCurve 只订了五个事件，没有它，所以开了回购的币每清算一次，`realQuoteReserve` 偏小、`realTokenReserve` 偏大，之后的价与毕业进度一直错、不会自愈。

dev 上 212 枚币没有一枚开回购，所以数据里还没出现。**建议**：订阅 `BuybackLocked`，在 handler 里同样累加 Curve 实体（`realQuoteReserve += buybackSpent`、`realTokenReserve -= tokensLocked`、`remainingSellableTokens` 同步）；这个事件发不发给我们都行。

### 3. 约定：同一个 `eventId` 的消息内容永远不变

`eventId` 是我们去重的唯一依据。消息形状或字段含义一旦改变，请**换 topic 重发**（联调期由后端负责人通知切换），不要在同一个 topic 里用旧 id 发新内容——后到的会被我们当成重复丢掉。

### 4. `txFrom`

`config.yaml` 的 `field_selection.transaction_fields` 目前只有 `hash`，加上 `from`，信封里多一个 `txFrom`（小写地址）。不阻塞，可缺。

### 顺带（不用改，知会一下）

- `CurveCompleted.curve` 给的是**关闭前**的储备；合约在这一刻已经把 `trackedNetQuote` / `trackedTokens` 清零。我们毕业金额读的是 `args.quoteAmount`，不受影响，只是文档里「曲线完成时实际持有的」这句不准。
- 代码里在发、但 `docs/` 没有文档的事件：`LaunchGraduated`（LaunchFactory）、`PoolRegistered`（只带 args）。
- 文档样例里的数字加减自洽，但不满足曲线公式（样例里 0.99 ETH 买到 100 枚，按那组储备应买到约 4150 万枚）。不影响使用，我们的价格断言用的是实抓的消息。

## 一眼看清

| 项 | 现状 | 我们要的 | 差距 | 处理 |
|---|---|---|---|---|
| topic | `launchpad.chain.events` | `launchpad.chain.event` | 名字差一个 s | **接受现状**，文档改成 `launchpad.chain.events` |
| Kafka key | **已改**：所有事件 key = token 地址（`cbcf16e`），base.md 写明「同一 Token 的事件进入同一分区并保持顺序」 | 同 | 无 | ✓ 关闭。Java 侧仍核对 key 与消息体反查出的 token，不一致打 WARN |
| `payload.curve` | **新增（`de9ac1b`）**：发币带 `graduationQuoteThreshold` / `initialVirtualQuoteReserve`（发币区块 `eth_call` 读曲线合约）；买 / 卖 / 退款 / 关闭带成交后的五个储备（按事件累加，不逐笔查链） | 我们原定放 `payload.derived`，并要一个现成的 `priceQuote` | 容器名不同；不给价、给两个定价储备 | **接受现状（用户 09-20 定）：字段以扫链为准。** Java 读 `payload.curve.*`，价由 Java 算：`virtualQuoteReserve ÷ virtualTokenReserve × 10^(18 − 配对资产精度)`，与合约 `getPricingReserves()` 两值相除一致；净募集 = `realQuoteReserve`。实抓数据已用合约公式逐笔复核 |
| `payload.token` | **新增**：曲线事件带 `payload.token.token`（Envio 从它的 Token 实体挑出来的字段，`pick(token, ['token'])`） | 我们原定 Envio 补的字段放 `payload.derived` | 容器名不同 | **接受并纳入契约**：`payload.token` = 从 Envio 的 Token 实体拷出的、与这个币有关的字段；`payload.derived` = 这一条事件算出来的字段（trader、费用、价格、余额）。两个容器各有各的语义，见[第 4 页](/messages) |
| 信封字段 | 有 `eventId` `eventName` `blockNumber` `blockHash` `blockTimestamp` `chainId` `logIndex` `removed` `txHash` `payload.address` `payload.args` `payload.token` `payload.curve` | 同左 + `txFrom` | 缺 `txFrom` | `txFrom` 加（开 `transaction_fields: [from]`），不阻塞 |
| 数值类型 | `blockNumber` `blockTimestamp` `chainId` `logIndex` 是 JSON number；`args` 里的整数是十进制字符串 | 全部十进制字符串 | 信封四个字段是 number | **接受现状**，都在安全整数范围内，Java 解析层两种都收 |
| 地址 / 哈希 | `0x` 小写 | 同 | 无 | — |
| `removed` | 「是否因链重组被移除」，语义上可能发 `true` | 恒 `false`，确认深度后才发 | 要不要确认深度没定 | 列入 P0 问清（[第 10 页](/rollout) Q3） |
| `blockTimestamp` | 有，秒 | 必须非 0 | 无 | — |
| 事件集合 | 6 种：TokenLaunched · CurveBuy · CurveSell · CurveCompleted · CurveBuyRefunded · AutoGraduationFailed | 9 种 + Heartbeat | **缺 6 种，多 2 种** | 见下节 |
| `derived` | 没有（曲线阶段要的值已由 `payload.curve` 给出） | 曲线阶段只剩可选的 `derived.trader`；Swap / Transfer / 建池的 `derived` 仍要 | 曲线阶段 ✓；其余随事件一起缺 | 见下节 |

## 事件集合

| 事件 | 现状 | 我们 | 说明 |
|---|---|---|---|
| TokenLaunched | 有 | 要 | args 齐全（17 个参数含 `socials.storyFun`）；毕业阈值与初始虚拟储备在 `payload.curve` ✓ |
| CurveBuy | 有 | 要 | args 齐全，`payload.token.token` 已给；储备在 `payload.curve` ✓（preload 重复发的 bug 见上） |
| CurveSell | 有 | 要 | 同上 |
| CurveCompleted | 有，带 `payload.token.token` | 要 | 字段齐，直接用；契约里已改为订这条，不再提 LaunchSwept |
| CurveBuyRefunded | 有 | 不要 | 退款不含在 `grossQuoteIn` 里，不影响任何数。多发无害，Java 会 SKIPPED，但白占审计表 |
| AutoGraduationFailed | 有 | 不要 | 排查用，多发无害 |
| **V4PoolGraduated** | 无 | 要 | 建池、初始价、`pool_id` |
| **PoolRegistered** | 无 | 要 | poolId 兜底 |
| **LaunchGraduationRescued** | 无 | 要 | 新终态 |
| **Swap** | 无 | 要 | **毕业后成交的唯一来源**，没有它已毕业的币没有价格、K 线、成交记录 |
| **Transfer** | 无 | 要 | **余额、持有者、持有人数的唯一来源** |
| **Heartbeat** | 无 | 要 | 分不清「市场安静」和「Envio 停了」 |

现状只覆盖曲线阶段的发币和买卖，**毕业后整条线（建池、Swap）和持有者线（Transfer）都还没有**。

## 每种事件缺的 derived 字段

现状所有事件都没有 `derived`。按[第 4 页](/messages)逐条列出要补的，含义与理由在那一页，这里只列清单。

### TokenLaunched · CurveBuy · CurveSell —— 已满足

`de9ac1b` 之后这三种事件要的值都有了，只是放在 `payload.curve` 而不是 `payload.derived`（接受，见上表）：

| 我们原来要的 | 现状里对应的 | 说明 |
|---|---|---|
| `derived.graduationQuoteThreshold` | `curve.graduationQuoteThreshold` | 值一致 |
| `derived.initialVirtualQuoteReserve` | `curve.initialVirtualQuoteReserve` | 值一致 |
| `derived.quoteReserve` | `curve.realQuoteReserve` | = 合约 `trackedNetQuote`；买 `+= netQuoteIn`、卖 `-= grossQuoteOut`，与合约一致 |
| `derived.priceQuote` | `curve.virtualQuoteReserve` ÷ `curve.virtualTokenReserve` | 不给现成的价，Java 自己除 |
| `derived.trader` | 无 | 本来就是可选：没给取 `recipient` / `seller` |

`curve.realTokenReserve` / `curve.remainingSellableTokens` 我们没有读者，忽略。

### Swap（整条缺）

`derived.side` `trader` `tokenAmount` `quoteAmount` `priceQuote` `liquidityQuote` 必须；token 按曲线事件的做法放 `payload.token.token`（`cbcf16e` 已加 PoolManager / PositionManager 的 ABI，Swap 应该在路上）。

### Transfer（整条缺）

`derived.fromBalance` `toBalance` `fromKind` `toKind` `totalSupply` `positiveBalanceCount`，全部必须；`from == 0x0` 的铸币不发。

### V4PoolGraduated（整条缺）

`derived.priceQuote` `liquidityQuote`。

## 建议：按这个顺序对齐

0. **先修 preload 重复发错值的 bug**（本页最上面第 1 条），修完换新 topic 重发。
1. ~~统一 key = token 地址~~ **已完成**（`cbcf16e`），曲线事件同时带上了 `payload.token.token`。
2. **曲线阶段的 `derived.trader` 只在名义地址是合约时给。** 前端不走 0x 的话这一步几乎没活；池内 Swap 的 trader 必须给。
3. **补 Transfer 与 Swap 两种事件。** 没有前者没有余额和持有者；没有后者已毕业的币是死的。
4. ~~补 CurveBuy / CurveSell 与 TokenLaunched 的 derived~~ **已由 `payload.curve` 满足**（`de9ac1b`）。
5. **补毕业三事件、Heartbeat。**
6. `CurveBuyRefunded` / `AutoGraduationFailed` 停发；config 里去掉 `Approval`；加 `txFrom`。

第 1、2 条做完 Java 就能开始联调曲线阶段；第 3 条做完才有毕业后与持有者；其余按顺序补。

## 我们这边随之调整的

- topic 名改用现状的 `launchpad.chain.events`
- 信封四个数值字段接受 JSON number（Java 解析层同时接受 number 与十进制字符串）
- `payload.signature` 降为可选
- 多发的 `CurveBuyRefunded` / `AutoGraduationFailed`：Java 无 handler 即 SKIPPED，不报错；但建议停发
- 接受 `payload.token` 作为「Token 实体字段」的容器，Java 认币只读 `payload.token.token`，不再按 curve / poolId 反查
