---
title: 3 · Envio 只做扫链：订阅、解码、补字段、发 Kafka
---

# Envio 只做扫链：订阅、解码、补字段、发 Kafka

一句话：**我们写一份 `config.yaml`、一份最小的 `schema.graphql` 和一组 TypeScript handler，indexer 从 QuickNode RPC 拉区块、跑 handler、把每条事件变成一条 Kafka 消息。** Postgres 只存 Envio 自己的同步状态和一份最小内部状态，没有 Hasura，Java 不读它。

同事已起的仓库 `amazing-socrates/envio`（测试网、纯 RPC、三个 handler、`publishKafka` effect 占位）就是这个形状的起点，往下填即可。

## 三个组件

| 组件 | 对我们意味着 |
|---|---|
| **QuickNode RPC** | 主网 4663 与测试网 46630 都走它（用户 09-18 定，不用 HyperSync）：`sync` 端点批量拉历史，`wss` 端点跟链头。RPC 的 `eth_getLogs` 按合约地址与 topic 过滤，动态注册的 curve / token 多了以后每批请求的地址列表会变长，Envio 自动分批 |
| **HyperIndex** | 声明链、合约、事件；handler 用 TypeScript 写；自动处理动态合约、批量读写、重组回滚 |
| **Postgres** | Envio 自用：同步游标、`raw_events`、最小内部状态。**不对外** |

## config.yaml

```yaml
chains:                                 # 主网 / 测试网各一份 config，按环境部署；两条链都是纯 QuickNode RPC，不用 HyperSync
  - id: 4663                          # Robinhood 主网
    start_block: <工厂部署区块>
    rpc:
      - url: <QuickNode 主网 https>
        for: sync                       # 批量拉历史
      - url: <QuickNode 主网 https>
        ws: <QuickNode 主网 wss>
        for: realtime                   # 跟链头
  - id: 46630                         # 测试网
    start_block: <工厂部署区块>
    rpc:
      - url: <QuickNode 测试网 https>
        for: sync
      - url: <QuickNode 测试网 https>
        ws: <QuickNode 测试网 wss>
        for: realtime

rollback_on_reorg: true

contracts:                              # 完整清单见第 9 页
  - name: LaunchFactory         # 固定地址。TokenLaunched / LaunchGraduationRescued
  - name: BondingCurve          # TokenLaunched 时 contractRegister。CurveBuy / CurveSell / CurveCompleted / SnipeTaxCharged
  - name: LaunchToken           # TokenLaunched 时 contractRegister。Transfer
  - name: GraduatedPoolHook     # 固定地址。PoolRegistered / HookFeeCollected
  - name: V4GraduationReceiver  # 固定地址。V4PoolGraduated
  - name: PoolManager           # 固定地址，Uniswap v4 核心。Swap（按 poolId 过滤）
  - name: QuoteAssetRegistry    # 固定地址。QuoteAssetConfigured：只存内部状态，不发消息
  # 费用 / 回购 / 治理类：订阅、空 handler、只进 raw_events

field_selection:
  transaction_fields: [hash, from]
raw_events: true
```

::: warning 两个要点
**PoolManager 上所有池的 Swap 都会进 handler。** 单例合约只能按地址订阅，handler 第一行按 `poolId` 查内部状态，查不到就 return，不发消息。

**配对资产（WETH / USDG / 股票代币）的 Transfer 不订阅。** 只认发射币。
:::

## 最小内部状态

只为补字段，不是业务实体，Java 不读。

```graphql
type Token @entity {                # 一个发射币一行
  id: ID!                         # token 地址
  curve: String! @index           # 曲线地址；曲线事件按 srcAddress 反查
  poolId: String @index           # PoolRegistered 后才有；Swap 按它反查
  poolLiquidity: BigInt!          # V4PoolGraduated 初值；算池侧储备用
  quoteAsset: String!             # 配对资产地址，零地址 = 原生 ETH
  quoteDecimals: Int!             # 来自 QuoteAssetConfig
  initialVirtualQuoteReserve: BigInt!
  graduationQuoteThreshold: BigInt!
  trackedNetQuote: BigInt!        # 买入 += netQuoteIn，卖出 -= grossQuoteOut；曲线关闭后冻结
  trackedTokens: BigInt!          # 初值 TOTAL_SUPPLY；买入 -= tokensOut，卖出 += tokensIn
  pendingSnipeTax: BigInt!        # 同 tx SnipeTaxCharged 先到、CurveBuy 后到的传递位
  totalSupply: BigInt!            # 初值 TOTAL_SUPPLY；Transfer 到零地址时减
  positiveBalanceCount: Int!      # 正余额地址数，含合约；Transfer 时按跨 0 增减
}

type Balance @entity {              # (token, holder) 一行；Transfer handler 维护，消息里给变动后的值
  id: ID!                         # token-holder
  token: String! @index
  holder: String!
  balance: BigInt!
}

type QuoteAssetConfig @entity {     # configHash 一行；TokenLaunched 按 quoteConfigHash 取
  id: ID!
  asset: String!
  decimals: Int!
  initialVirtualQuoteReserve: BigInt!
  graduationQuoteThreshold: BigInt!
}
```

## handler 做什么

每个 handler 三步：解码 → 补 `derived` → 调 `publish` effect。不做任何口径。

- **QuoteAssetConfigured**：upsert `QuoteAssetConfig`，**不发消息**（Java 不需要；TokenLaunched 的 derived 里带精度 / 阈值 / 初始储备）
- **TokenLaunched**：`contractRegister` curve 与 token；建 `Token`，精度、初始储备、阈值从 `QuoteAssetConfig` 取；`derived` 带这三项；发消息。总供应 / 精度 / 铸币量是 `LaunchDefaults` 常数，Java 自己有，不发
- **SnipeTaxCharged**：写 `Token.pendingSnipeTax`，**不发消息**
- **CurveBuy / CurveSell**：更新两个储备；`derived` = token、**trader（见下一节）**、baseFee / creatorTax / snipeTax（按合约 `_splitBuyFees` 与卖出税率拆好；snipeTax 取走并清零）、quoteReserve、tokenReserve、priceQuote、liquidityQuote；发消息
- **CurveCompleted / V4PoolGraduated / PoolRegistered / LaunchGraduationRescued**：PoolRegistered 写 `Token.poolId`；四个都原样发消息（曲线关闭订曲线的 CurveCompleted，工厂的 LaunchSwept 不订）
- **Swap**：按 `poolId` 查 `Token`，查不到 return；`derived` = token、side、**trader（见下一节）**、tokenAmount、quoteAmount、priceQuote、liquidityQuote；fee / creatorTax 由同 tx 紧随其后的 `HookFeeCollected` 补（它在 `afterSwap` 里发，logIndex 紧挨着 Swap），所以 Swap 暂存、在 HookFeeCollected handler 里发
- **HookFeeCollected**：取出暂存的 Swap，补 fee / creatorTax / feeCurrency，发消息
- **流动性 `derived.liquidityQuote`**（CurveBuy / CurveSell / V4PoolGraduated / Swap 都给，以配对资产计）：曲线阶段 = `trackedNetQuote × 2`；毕业后 = 池两侧按池价折成配对资产之和，全区间仓位下两侧各 `L × (√P − √P_lower)` 与 `L × (√P_upper − √P) ÷ (√P × √P_upper)`，按 currency0 / 1 方向与精度整理。Java 只乘配对资产价，不存池子信息；W1 用真实池对 `balanceOf(PoolManager)` 核一次
- **Transfer**：`from` 为零地址（铸币）只更新 `Balance`，**不发消息**（Java 收到 TokenLaunched 时按常量 TOTAL_SUPPLY 写曲线余额）；其余更新 `Balance(token, from)` 与 `Balance(token, to)`，`to` 为零地址减 `Token.totalSupply`，余额跨 0 时 `positiveBalanceCount` ±1；`derived` = fromBalance、toBalance、fromKind、toKind、totalSupply、positiveBalanceCount（余额都是**变动后的绝对值**；kind 按 config 里的固定地址 + 该币的 curve 判）；发消息。Java 拿到就 set，不累加
- **Heartbeat**：`onBlock` 每 N 块（约一分钟）发一条 headBlock / processedBlock / processedBlockTime；Java 用来判断 Envio 是否活着
- **费用 / 回购 / 治理类**：空 handler，只进 `raw_events`

## 交易者归属：在 Envio 里做，用整笔收据算

上一版把这件事放在 Java，靠事件里的名义地址加「是合约就拉收据穿透」，v4 池内成交的买家一直认不准。原因不在规则，在**Java 单看一条消息看不到整笔交易**。这件事只有看得到整笔 tx 的一方能做，就是 Envio。

**规则（与上一版 Java 里已验证过的一致）：**

1. **名义交易者**：`CurveBuy.recipient` / `CurveSell.seller`；池内没有名义地址
2. **净流量**：取这笔 tx 里本币的全部 `Transfer`，按地址算净流入（to 加、from 减），剔除零地址和成交场所（curve / PoolManager）。买入取**净流入最大**的地址，卖出取**净流出最大**的地址
3. **曲线**：名义地址不是合约 → 直接用；是合约（路由、0x Settler、聚合器）→ 用净流量；净流量解不出 → 退回名义地址（曲线成交不丢行）
4. **池内**：一律用净流量；解不出 → `trader = null`，Java 照写成交行但不进 Activity 与持仓
5. **「是合约」只决定要不要走净流量，不决定归属**：AA / 合约钱包本身就是用户，净流量会正确选中它；中继收多少转多少净为 0，自然出局

**为什么不能靠区块内 handler 顺序凑。** 池内一笔买入的日志顺序是 `Swap → HookFeeCollected → Transfer(PoolManager → 用户)`，Transfer 在 Swap **之后**；经 0x Settler 时还有第二条 `Settler → 用户`。Swap handler 跑的时候这些 Transfer 还没到，等 Transfer handler 回填又不知道哪条是最后一条。所以不用顺序，直接问链：

```ts
// 输入定了输出就定：某 tx 里某 token 的全部 Transfer。cache: true，重跑直接命中
export const tokenTransfersInTx = createEffect({
  name: "tokenTransfersInTx",
  input: { txHash: S.string, token: S.string },
  output: S.array(S.schema({ from: S.string, to: S.string, value: S.string })),
  cache: true,
}, async ({ input }) => {
  // eth_getTransactionReceipt(txHash) → 只留 address == token 且 topic0 == Transfer 的日志
});

export const isContract = createEffect({          // eth_getCode != 0x；cache: true
  name: "isContract", input: { address: S.string }, output: S.boolean, cache: true,
}, async ({ input }) => { /* … */ });
```

- 收据在 handler 跑的时候一定已经在链上（区块已出），Effect 走 RPC，`cache: true` 落库，重跑不再打链
- 曲线成交只在名义地址是合约时才调 `tokenTransfersInTx`；直调曲线的成交零额外 RPC；`isContract` 的命中集合很小（几个路由 / 中继），缓存一暖就没有 RPC
- 池内成交每笔一次收据；量与池内成交数同阶，可接受
- 排除名单（PoolManager、TradeRouter、Universal Router、curve）写在 config，只用于第 2 条的「成交场所」剔除，**不用于判定用户**

**Java 侧完全不碰这件事**：拿到 `derived.trader` 直接落 `trader_address`；两个来源合并、CONFLICT 判定、`ContractProbe`、`TokenNetFlow` 全部删除。

::: info 同 tx 配对的两组
`SnipeTaxCharged → CurveBuy`（税在前，用 `Token.pendingSnipeTax` 传递）、`Swap → HookFeeCollected`（费在后，暂存 Swap 到 HookFeeCollected 再发）。这两组顺序由合约代码决定，是确定的；Transfer 不参与配对，归属走收据。
:::

## 发送：确认深度、顺序、至少一次

- **确认深度。** Envio 的重组回滚只回滚它的实体，**不会撤回已发的消息**。所以 `publish` 只在区块落后链头 ≥ N 块后才发（N 由链的最终性定，Robinhood 几乎不重组，取小值）。Java 侧 `removed=true` 分支保留但不会走到
- **分区键 = token 地址。** 发币、曲线、毕业、Transfer、Swap 都能关联到 token；同币事件严格有序，异币并行
- **至少一次。** producer `acks=all`、重试开；Java 按 `eventId` 去重。**不做 exactly-once**
- **发送失败。** effect 抛异常，Envio 会重跑这一批；不吞
- **重放。** 要重放某段，改 `start_block` 重跑或用官方的 `envio start --restart`，Java 靠 eventId 去重。新合约从部署区块起扫，没有历史包袱

## 运维

- 单实例，不要起两个（会重复发消息，虽然 Java 去重）
- Prometheus 指标接现有监控；「已处理区块落后链头」告警
- `config.yaml` 里的 RPC key 用环境变量，仓库里现在有一把 Alchemy key 明文，要撤掉
- dev / test / prod 各一套；Postgres 只是 Envio 自用，容量按 `raw_events` 增长估
