---
title: 3 · Envio 只做扫链：订阅、解码、补字段、发 Kafka
---

# Envio 只做扫链：订阅、解码、补字段、发 Kafka

一句话：**我们写一份 `config.yaml`、一份最小的 `schema.graphql` 和一组 TypeScript handler，indexer 从 HyperSync / RPC 拉区块、跑 handler、把每条事件变成一条 Kafka 消息。** Postgres 只存 Envio 自己的同步状态和一份最小内部状态，没有 Hasura，Java 不读它。

同事已起的仓库 `amazing-socrates/envio`（测试网、纯 RPC、三个 handler、`publishKafka` effect 占位）就是这个形状的起点，往下填即可。

## 三个组件

| 组件 | 对我们意味着 |
|---|---|
| **HyperSync** | 主网 4663 在支持列表里，按合约地址和事件签名直接取日志；测试网 46630 不在，走 RPC |
| **HyperIndex** | 声明链、合约、事件；handler 用 TypeScript 写；自动处理动态合约、批量读写、重组回滚 |
| **Postgres** | Envio 自用：同步游标、`raw_events`、最小内部状态。**不对外** |

## config.yaml

```yaml
chains:
  - id: 4663                          # Robinhood 主网
    start_block: <工厂部署区块>
    hypersync: https://4663.hypersync.xyz
    rpc:
      - url: <主网 RPC>
        for: fallback
  - id: 46630                         # 测试网：纯 RPC
    start_block: <工厂部署区块>
    rpc:
      - url: <测试网 RPC>
        for: sync
      - url: <测试网 wss>
        for: realtime

rollback_on_reorg: true

contracts:                              # 完整清单见第 9 页
  - name: LaunchFactory         # 固定地址。TokenLaunched / LaunchSwept / LaunchGraduationRescued
  - name: BondingCurve          # TokenLaunched 时 contractRegister。CurveBuy / CurveSell / SnipeTaxCharged
  - name: LaunchToken           # TokenLaunched 时 contractRegister。Transfer
  - name: GraduatedPoolHook     # 固定地址。PoolRegistered / HookFeeCollected
  - name: V4GraduationReceiver  # 固定地址。V4PoolGraduated
  - name: PoolManager           # 固定地址，Uniswap v4 核心。Swap（按 poolId 过滤）
  - name: QuoteAssetRegistry    # 固定地址。QuoteAssetConfigured
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
  quoteAsset: String!             # 配对资产地址，零地址 = 原生 ETH
  quoteDecimals: Int!             # 来自 QuoteAssetConfig
  initialVirtualQuoteReserve: BigInt!
  graduationQuoteThreshold: BigInt!
  trackedNetQuote: BigInt!        # 买入 += netQuoteIn，卖出 -= grossQuoteOut；曲线关闭后冻结
  trackedTokens: BigInt!          # 初值 TOTAL_SUPPLY；买入 -= tokensOut，卖出 += tokensIn
  pendingSnipeTax: BigInt!        # 同 tx SnipeTaxCharged 先到、CurveBuy 后到的传递位
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

- **QuoteAssetConfigured**：upsert `QuoteAssetConfig`；发消息
- **TokenLaunched**：`contractRegister` curve 与 token；建 `Token`，精度、初始储备、阈值从 `QuoteAssetConfig` 取；`derived` 带这三项与 `totalSupply`（`LaunchDefaults.TOTAL_SUPPLY`）；发消息
- **SnipeTaxCharged**：写 `Token.pendingSnipeTax`，**不发消息**
- **CurveBuy / CurveSell**：更新两个储备；`derived` = token、trader、snipeTax（取走并清零）、quoteReserve、tokenReserve、priceQuote；发消息
- **LaunchSwept / V4PoolGraduated / PoolRegistered / LaunchGraduationRescued**：PoolRegistered 写 `Token.poolId`；四个都原样发消息
- **Swap**：按 `poolId` 查 `Token`，查不到 return；`derived` = token、side、trader、tokenAmount、quoteAmount、priceQuote；**fee / creatorTax 由同 tx 紧随其后的 HookFeeCollected 补**，所以 Swap 的消息在 HookFeeCollected handler 里发（同 tx、同区块，Envio 顺序执行）
- **HookFeeCollected**：取出暂存的 Swap，补 fee / creatorTax，发消息
- **Transfer**：原样发消息，`derived` 为空。**trader 穿透用的就是它**：CurveBuy / Swap 的 handler 看同 tx 里本币的 Transfer 净流量（Envio 在一个区块内按 logIndex 顺序执行，Transfer 在 CurveBuy 之前已处理；池内 Transfer 在 Swap 之后，所以 Swap 的 trader 在 Transfer handler 里回填后再发）
- **费用 / 回购 / 治理类**：空 handler，只进 `raw_events`

::: info 同 tx 配对的三组
`SnipeTaxCharged → CurveBuy`、`Swap → Transfer → HookFeeCollected`、`LaunchSwept ↔ CurveCompleted`。Envio 在同一区块内按 logIndex 顺序跑 handler，用 `Token` 上的传递位或按 `txHash` 暂存就能配对；具体先后以 W1 真实 tx 为准。
:::

## 发送：确认深度、顺序、至少一次

- **确认深度。** Envio 的重组回滚只回滚它的实体，**不会撤回已发的消息**。所以 `publish` 只在区块落后链头 ≥ N 块后才发（N 由链的最终性定，Robinhood 几乎不重组，取小值）。Java 侧 `removed=true` 分支保留但不会走到
- **分区键 = token 地址。** 发币、曲线、毕业、Transfer、Swap 都能关联到 token；同币事件严格有序，异币并行
- **至少一次。** producer `acks=all`、重试开；Java 按 `eventId` 去重。**不做 exactly-once**
- **发送失败。** effect 抛异常，Envio 会重跑这一批；不吞
- **回填与重放。** 首次上线从 `start_block` 全量扫一遍并全部发出；以后要重放某段，改 `start_block` 重跑或用官方的 `envio start --restart`，Java 靠 eventId 去重

## 运维

- 单实例，不要起两个（会重复发消息，虽然 Java 去重）
- Prometheus 指标接现有监控；「已处理区块落后链头」告警
- `config.yaml` 里的 RPC key 用环境变量，仓库里现在有一把 Alchemy key 明文，要撤掉
- dev / test / prod 各一套；Postgres 只是 Envio 自用，容量按 `raw_events` 增长估
