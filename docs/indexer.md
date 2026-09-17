---
title: 4 · 九个实体、两个 Effect、一组 handler
---

# 九个实体、两个 Effect、一组 handler

**职责一句话：把我们合约的事件解码成事实实体，维护只靠加减和取最后值就能得到的派生实体，并按区块时间给成交和桶写上 USD。** 它不判业务状态、不认识短剧和用户、不算跟现价走的数。实体只有九个，**每一个都能说出至少一个读它的接口或定时线**，没有读者的事件不建实体。

## config.yaml：链与合约

```yaml
# 主网 / 测试网各一份 config，按环境部署。合约源码在 workspace 根 src/，地址与 start_block 部署后填
chains:
  - id: 4663                          # Robinhood 主网
    start_block: <工厂部署区块>
    hypersync: https://4663.hypersync.xyz
    rpc:
      - url: <QuickNode 主网>
        for: fallback                   # HyperSync 20 秒没新块自动切过来
  - id: 46630                         # 测试网：HyperSync 不支持，纯 RPC
    start_block: <工厂部署区块>
    rpc:
      - url: <QuickNode 测试网>
        for: sync
      - url: <QuickNode 测试网 wss>
        for: realtime

rollback_on_reorg: true

contracts:                              # 完整订阅清单见[第 9 页](/events)「Envio 订阅清单」
  - name: LaunchFactory         # 固定地址。TokenLaunched / LaunchSwept / LaunchGraduationRescued / CreatorFeeRecipientUpdated / BuybackEnabledUpdated；配置类事件空 handler
  - name: BondingCurve          # 无地址，TokenLaunched 时 contractRegister。CurveBuy / CurveSell / SnipeTaxCharged；费用类与退款空 handler
  - name: LaunchToken           # 无地址，TokenLaunched 时 contractRegister。Transfer
  - name: GraduatedPoolHook     # 固定地址。PoolRegistered / HookFeeCollected；PoolFeesSwept 等空 handler
  - name: V4GraduationReceiver  # 固定地址。V4PoolGraduated
  - name: PoolManager           # 固定地址，Uniswap v4 核心合约（不在 src/）。Swap / ModifyLiquidity，handler 按 Token.poolId 过滤
  - name: QuoteAssetRegistry    # 固定地址。QuoteAssetConfigured
  - name: LiquidityLocker       # 固定地址。TokenDustLocked
  - name: FeeEscrow             # 固定地址。Credited / CreditedToken / Claimed / ClaimedToken，暂空 handler（TODO 费用）
  - name: BuybackVault          # 固定地址。Locked / Released，暂空 handler（TODO 费用）

field_selection:
  transaction_fields: [hash, from]  # 给 txFrom
raw_events: true                     # 原始日志留着当审计，空 handler 的事件全靠它
```

::: warning 一个静态的地方，和一个故意不索引的东西
**PoolManager 上所有池的 Swap 都会进 handler。** 单例合约，只能按地址订阅，handler 第一行用 `Token.getWhere.poolId.eq()` 反查，查不到就丢弃。HyperSync 取日志便宜，handler 里一次索引查询也便宜，可以接受。

**配对资产（WETH / USDG / 股票代币）的 Transfer 不索引。** 它们的持有者是全链所有地址，事件量是我们发射台自己的几十倍，而我们只在资产页要「这一个登录地址持有多少」，那是几次 `balanceOf` 的事，见[第 5 页](/java)。索引层只认发射币。
:::

## 取价 Effect：handler 最重要的外部调用

```ts
// 输入定了输出就定：某资产某分钟的美元价。cache: true 落库，重跑直接命中，不再打 MySQL
export const pairPriceAt = createEffect({
  name: "pairPriceAt",
  input: { asset: S.string, minute: S.number },   // minute = floor(blockTimestamp / 60)
  output: S.nullable(S.string),                    // 十进制字符串；null = 那一分钟之前一小时内没有价格行
  rateLimit: false,
  cache: true,
}, async ({ input }) => {
  // 查 MySQL launchpad_coin_price：asset 相同、priced_at ≤ minute 的最近一行，距离超过 60 分钟返回 null
  // 也可以查 Redis 的 sorted set，同一份数据；MySQL 是源，Redis 只是副本
});
```

- **取的是「之前最近一行」，不是当前价。** 跟链头时拿到的就是最新一行；重跑历史时拿到的是当时的价。这就是「重跑与增量一致」的保证
- **缓存键是（资产，分钟）**，同一分钟内的几百笔成交只查一次；缓存落在 Envio 的 Postgres，重建索引也不用再打 MySQL
- **拿不到就写 null**，只在停机窗口发生；不回落到别的时间，不猜。线一恢复后新的成交自然有价，空档不补，与现有「宁可缺失」一致
- **头块的竞争。** 成交所在分钟的价格行可能还没落，取到的是上一分钟的，误差一分钟，接受

## schema.graphql：实体

```graphql
# 设计规则：每个实体至少有一个读者（接口或定时线）。没有读者的事件不建实体，原始日志留在 raw_events，要用时加 handler 重跑
# 约定：金额 BigInt 最小单位；价格 BigDecimal 以配对资产计；地址小写字符串；USD 只在 Trade / Candle / ProtocolDay 上，成交时点固化，缺价为 null
# @index：Envio 建表时顺手建 Postgres 索引。复合索引若当前版本不支持，建表后在 Postgres 手工补，W1 验

type QuoteAssetConfig @entity {                 # 链上注册的配对资产经济参数，一个 configHash 一行。读者：TokenLaunched handler、Java 线二的配对资产名单
  id: ID!                                     # QuoteAssetConfigured.configHash
  asset: String! @index                       # 配对资产地址；零地址 = 原生 ETH
  decimals: Int!                              # 配对资产精度，合约校验过与 ERC20 一致
  initialVirtualQuoteReserve: BigInt!         # 曲线初始虚拟 quote 储备，算价格要用
  graduationQuoteThreshold: BigInt!           # 毕业阈值，最小单位
  enabled: Boolean!                           # 当前是否允许新发币选它
  version: String!                            # 模板 / 校准算法标识
  updatedAtBlock: BigInt!                     # 最后变动的区块
}

type Token @entity {                            # 一个发射币一行。Java 拷进 launchpad_token 的就是它
  id: ID!                                     # token 合约地址
  curve: String! @index                       # 曲线合约地址；曲线发出的事件按 srcAddress 反查是哪个币
  deployer: String!                           # TokenLaunched.creator，原始发起人（经 TradeRouter 发币也是用户本人）
  pairToken: String!                          # TokenLaunched.quoteAsset，零地址 = 原生 ETH
  pairTokenDecimals: Int!                     # 来自 QuoteAssetConfig(quoteConfigHash)，不用 eth_call
  pairTokenSymbol: String                     # 原生币写 ETH；ERC20 用 Effect 读一次 symbol()，或由 Java 按地址从运营名单补
  quoteConfigHash: String!                    # 指向发币时快照的 QuoteAssetConfig
  initialVirtualQuoteReserve: BigInt!         # 从 QuoteAssetConfig 拷来，算成交后价格的常数项
  graduationThreshold: BigInt!                # 从 QuoteAssetConfig 拷来；进度条分母
  launchConfigId: Int!                        # 版本化发射配置 id
  curveFeeBps: Int!                           # 基础手续费 BPS，发币时快照；拆费用要用
  creatorTaxBps: Int!                         # 创作者税 BPS，不可变
  tickSpacing: Int!                           # 毕业池的 tick spacing
  creatorFeeRecipient: String!                # 当前创作者费收款人；工厂 CreatorFeeRecipientUpdated 更新
  buybackEnabled: Boolean!                    # 当前回购开关；工厂 BuybackEnabledUpdated 更新
  totalSupply: BigInt!                        # 初值 10 亿 × 1e18（LaunchDefaults.TOTAL_SUPPLY）；Transfer 到零地址时减
  decimals: Int!                              # 恒为 18
  lockedSupply: BigInt!                       # TokenDustLocked 累加；现行口径不用它算市值
  name: String!                               # 以下 metadata 全部来自 TokenLaunched 事件本身，不用取 URI
  symbol: String!                             # 代号
  logo: String                                # 币图 URI，不清洗
  description: String                         # 简介
  website: String                             # 普通官网链接
  storyFun: String                            # Story.Fun 主页或发射页链接；叙事绑定解析它，解析在 Java
  twitter: String                             # 社交链接
  telegram: String                            # 社交链接
  discord: String                             # 社交链接
  farcaster: String                           # 社交链接
  launchTx: String!                           # 发币交易哈希
  launchBlock: BigInt!                        # 发币区块号
  launchedAt: BigInt!                         # 发币区块时间，秒
  txFrom: String!                             # 发币交易的 from
  curveClosedAt: BigInt                       # LaunchSwept 的区块时间；非空即产品口径的「已毕业」，状态名在 Java 判
  poolCreatedAt: BigInt                       # V4PoolGraduated 的区块时间
  rescuedAt: BigInt                           # LaunchGraduationRescued 的区块时间；终态，产品待定怎么展示
  poolId: String @index                       # Uniswap v4 poolId，来自 PoolRegistered。Swap handler 用 getWhere.poolId 反查
  poolQuoteToken: String                      # 池的计价资产，来自 PoolRegistered
  positionId: BigInt                          # 锁定的 PositionManager NFT id
  poolLiquidity: BigInt!                      # 初值 V4PoolGraduated.liquidity，之后按 ModifyLiquidity 累加
  trackedNetQuote: BigInt!                    # 曲线净储备：买入加 netQuoteIn，卖出减 grossQuoteOut。毕业进度分子；关闭后冻结
  trackedTokens: BigInt!                      # 曲线库存：初值 TOTAL_SUPPLY，买入减 tokensOut，卖出加 tokensIn；关闭后冻结
  cumVolumeCurve: BigInt!                     # 曲线累计成交量：Σ grossQuoteIn + Σ grossQuoteOut
  cumVolumePool: BigInt!                      # 池内累计成交量，配对资产侧
  tradeCount: Int!                            # 累计成交笔数
  lastPriceQuote: BigDecimal!                 # 最后一笔成交后的边际价，配对资产计（见 Trade.priceQuote）
  lastTradeAt: BigInt! @index                 # 最后一笔成交时间
  positiveBalanceCount: Int!                  # 正余额地址数，含合约
  pendingSnipeTax: BigInt!                    # 同 tx 里 SnipeTaxCharged 先到、CurveBuy 后到的传递位，CurveBuy 消费后清零
  updatedAtBlock: BigInt! @index              # 任一字段变动就推进；Java 同步器按它增量
}

type Trade @entity {                            # 一笔成交一行；除 trader 与池内手续费回填外不修改。读者：成交页签、K 线 M5、Activity、历史持仓（卖出行）
  id: ID!                                     # 区块号补零 12 位 + "-" + logIndex 补零 6 位；按 id 排序即时间序，游标分页用它
  token: Token! @index                        # 所属发射币
  kind: TradeKind!                            # CURVE_BUY / CURVE_SELL / POOL_SWAP，事件来源
  side: Side!                                 # BUY / SELL。曲线由事件定；池内看本币是流向用户（BUY）还是流出（SELL）。Position 与 pnl 按它算，读接口直接用
  tokenIn: BigInt!                            # 用户付出的本币数量，卖出时非零
  tokenOut: BigInt!                           # 用户收到的本币数量，买入时非零
  quoteIn: BigInt!                            # 买入：CurveBuy.grossQuoteIn，用户实付，含全部费与税，不含退款
  netQuoteIn: BigInt!                         # 买入：进入定价储备的部分 = quoteIn − fee
  grossQuoteOut: BigInt!                      # 卖出：离开定价储备的部分，扣费前
  quoteOut: BigInt!                           # 卖出：CurveSell.netQuoteOut，用户实收
  fee: BigInt!                                # 事件给的费用总额：买 = 基础费 + 创作者税 + 反狙击税，卖 = 基础费 + 创作者税；池内 = HookFeeCollected.fee
  baseFee: BigInt!                            # 基础手续费；买按 _splitBuyFees 比例，卖 = fee − creatorTax
  creatorTax: BigInt!                         # 创作者税；买按 _splitBuyFees 比例，卖 = grossQuoteOut × creatorTaxBps ÷ 10000 向下取整，池内 = HookFeeCollected.creatorTax
  snipeTax: BigInt!                           # 反狙击税，来自同 tx 的 SnipeTaxCharged；没有则 0
  avgPriceQuote: BigDecimal!                  # 这笔的成交均价：买 netQuoteIn ÷ tokenOut，卖 grossQuoteOut ÷ tokenIn。持仓成本用它
  priceQuote: BigDecimal!                     # 成交后的边际价：曲线 = (initialVirtualQuoteReserve + trackedNetQuote) ÷ (VIRTUAL_TOKEN_OFFSET + trackedTokens)，池内由 sqrtPriceX96 换算。K 线用它
  initiator: String!                          # CurveBuy.buyer / CurveSell.seller / Swap.sender；经路由时是路由地址
  recipient: String                           # CurveBuy / CurveSell 的 recipient；池内为 null
  txFrom: String!                             # 交易发起人
  poolId: String                              # 池内成交才有
  trader: String @index                       # 交易者：曲线买 = recipient、卖 = seller；池内由同 tx 随后的 Transfer 回填；解不出为 null。Activity 按它查
  quoteUsdPrice: BigDecimal                   # pairPriceAt(pairToken, 区块时间所在分钟)；null = 缺价
  amountUsd: BigDecimal                       # 买 quoteIn、卖 quoteOut 换整枚 × quoteUsdPrice
  costQuoteReleased: BigDecimal               # 只有卖出有值：本次卖出量 × 卖出前的均价，配对资产计；卖出量超过 qtyTraded 的部分按 0 成本
  costUsdReleased: BigDecimal                 # 同上，USD 口径的成本
  pnlQuote: BigDecimal                        # 只有卖出有值：quoteOut − costQuoteReleased。历史持仓页每行的盈亏
  pnlUsd: BigDecimal                          # 只有卖出有值：amountUsd − costUsdReleased
  pnlPct: BigDecimal                          # 只有卖出有值：pnlQuote ÷ costQuoteReleased；成本为 0 时 null
  blockNumber: BigInt!                        # 区块号
  logIndex: Int!                              # 日志序号
  timestamp: BigInt! @index                   # 区块时间，秒
  txHash: String! @index                      # 交易哈希；Transfer 与 HookFeeCollected 的 handler 用 getWhere.txHash 找本 tx 的成交回填
}

type Balance @entity {                          # 发射币的持有者余额，一个（币, 地址）一行。读者：持有者榜、持仓页的平台币、线二
  id: ID!                                     # asset-account；线二按 deployer / curve / PoolManager 直接 get
  asset: String! @index                       # 发射币地址；持有者榜按它查。不记配对资产
  token: Token!                               # 所属发射币
  account: String! @index                     # 持有地址；持仓页按它查
  balance: BigInt!                            # 余额，最小单位；Transfer 一到就 from 减 to 加。持有者榜按它倒序，要 (asset, balance) 复合索引
  updatedAtBlock: BigInt!                     # 最后变动的区块
}

type Position @entity {                         # 一个地址在一个币上的持仓，一行、永不关闭。读者：持仓页、按币汇总的历史。移动平均成本法
  id: ID!                                     # trader-token
  trader: String! @index                      # 持有地址；持仓页按它查
  token: Token!                               # 所属发射币
  qtyTraded: BigInt!                          # 买入量 − 卖出量，只算成交，不含转入转出；恰好归零时成本一并归零
  costQuote: BigDecimal!                      # 剩余成本，配对资产计：买入加 quoteIn，卖出按当时均价扣
  costUsd: BigDecimal!                        # 剩余成本，USD：买入加 amountUsd，卖出按当时 USD 均价扣
  avgCostQuote: BigDecimal                    # costQuote ÷ qtyTraded；持仓页的「下单均价」，qtyTraded 为 0 时 null
  boughtQty: BigInt!                          # 累计买入量（生命周期内，不随归零重置）
  boughtQuote: BigDecimal!                    # 累计买入额，配对资产计
  boughtUsd: BigDecimal!                      # 累计买入额，USD，成交时点固化
  soldQty: BigInt!                            # 累计卖出量
  soldQuote: BigDecimal!                      # 累计卖出所得，配对资产计
  soldUsd: BigDecimal!                        # 累计卖出所得，USD，成交时点固化
  realizedPnlQuote: BigDecimal!               # 累计已实现盈亏 = Σ 每笔卖出的 pnlQuote
  realizedPnlUsd: BigDecimal!                 # 累计已实现盈亏，USD
  buyCount: Int!                              # 买入笔数
  sellCount: Int!                             # 卖出笔数
  firstTradeAt: BigInt!                       # 首笔成交时间
  lastTradeAt: BigInt! @index                 # 末笔成交时间；持仓页按它倒序
}

type CandleMinute @entity {                     # 分钟桶，只有有成交的分钟才有行。读者：K 线 H1 / H6 / D1、线三的首尾两小时
  id: ID!                                     # token-periodStart
  token: Token! @index                        # 所属发射币
  periodStart: BigInt! @index                 # 桶起点，秒，整分钟；K 线按 (token, periodStart) 范围查，线三按 periodStart 跨币查
  open: BigDecimal!                           # 开盘价 = 上一笔成交价，配对资产计
  high: BigDecimal!                           # 桶内最高成交价
  low: BigDecimal!                            # 桶内最低成交价
  close: BigDecimal!                          # 桶内最后一笔成交价
  volumeCurve: BigInt!                        # 曲线阶段成交量，配对资产最小单位
  volumePool: BigInt!                         # 池内成交量；分开存，「含不含 DEX」在 Java 决定
  txCountCurve: Int!                          # 曲线成交笔数
  txCountPool: Int!                           # 池内成交笔数
  quoteUsdPrice: BigDecimal                   # 桶起点那一分钟的配对资产美元价；null = 缺价
  openUsd: BigDecimal                         # open × quoteUsdPrice
  highUsd: BigDecimal                         # high × quoteUsdPrice
  lowUsd: BigDecimal                          # low × quoteUsdPrice
  closeUsd: BigDecimal                        # close × quoteUsdPrice；K 线的点。marketCapUsd = closeUsd × totalSupply 在 Java 读时算
  volumeUsdCurve: BigDecimal                  # 曲线成交的 amountUsd 逐笔累加，缺价的那笔不计
  volumeUsdPool: BigDecimal                   # 池内成交的 amountUsd 逐笔累加
  updatedAtBlock: BigInt!                     # 最后变动的区块
}

type CandleHour @entity {                       # 小时桶，字段与 CandleMinute 完全相同。读者：K 线 ALL 档 30 天以内、线三的完整小时
  # … 同上，periodStart 取整小时 …
}

type CandleDay @entity {                        # UTC 日桶，字段与 CandleMinute 完全相同。读者：K 线 ALL 档超过 30 天，合并成 1 周 / 1 月
  # … 同上，periodStart 取整 UTC 日 …
}

type ProtocolDay @entity {                      # 协议日桶，UTC 日 × 配对资产一行。读者：协议数据页。发射数与去重发射者由 Java 从 launchpad_token 按日数
  id: ID!                                     # dayIndex-pairToken
  dayIndex: Int! @index                       # floor(区块时间 / 86400)；按最近 90 天查
  pairToken: String!                          # 配对资产地址
  volumeCurve: BigInt!                        # 当日曲线成交量，最小单位
  volumePool: BigInt!                         # 当日池内成交量
  volumeUsdCurve: BigDecimal!                 # 当日曲线成交 amountUsd 累加，缺价的不计
  volumeUsdPool: BigDecimal!                  # 当日池内成交 amountUsd 累加
  updatedAtBlock: BigInt!                     # 最后变动的区块
}
```

### 去掉了什么，为什么

| 没建的实体 | 它要解决的事 | 怎么解决 |
|---|---|---|
| `Transfer` | Java 回填交易者、Java 回滚时重算余额 | 交易者在 Transfer handler 里当场回填，回滚由 Envio 做，两个用途都没了。数据量最大，不建 |
| `Pool` | Swap handler 拿 poolId 反查是哪个币 | `Token.poolId` 加 `@index`，handler 用 `Token.getWhere.poolId.eq()` |
| `TxSwap` | Transfer handler 拿 txHash 找要回填的 Trade | `Trade.txHash` 加 `@index`，`Trade.getWhere.txHash.eq()` 再按 token 与 kind 过滤 |
| `Refund` · `FeeAccrual` · `ConfigChange` | 没有读者，「宁可多存」 | 那条原则是重索引很贵时的保险，自建 Envio 重跑是分钟级。事件仍订阅、空 handler，原文留在 `raw_events`，要用时加 handler 重跑 |

### 每条查询对应的索引

| 读者 | 查询 | 索引 |
|---|---|---|
| Token 同步器 | `Token` where `updatedAtBlock ≥ N` | token(updatedAtBlock) |
| 同步器每小时自愈 | `Token` where `lastTradeAt ≥ now − 24h` | token(lastTradeAt) |
| Swap handler | `Token` where `poolId = ?` | token(poolId) |
| 曲线事件 handler | `Token` where `curve = srcAddress` | token(curve) |
| 成交页签 | `Trade` where `token = ?` and `id < cursor` order by id desc | trade(token_id, id) |
| K 线 M5 | `Trade` where `token = ?` and `timestamp ≥ ?` | trade(token_id, timestamp) |
| Activity | `Trade` where `trader in (…)` order by timestamp desc | trade(trader, timestamp) |
| 历史持仓 | `Trade` where `trader in (…)` and 卖出 order by timestamp desc | trade(trader, timestamp)，同上 |
| 持仓页 | `Position` where `trader in (…)` order by lastTradeAt desc | position(trader, lastTradeAt) |
| Transfer / HookFeeCollected handler 回填 | `Trade` where `txHash = ?` | trade(txHash) |
| 持有者榜 | `Balance` where `asset = ?` order by balance desc limit 120 | balance(asset, balance desc) |
| 持仓页 | `Balance` where `account = ?` | balance(account) |
| K 线 H1 / H6 / D1 / ALL | `CandleMinute` / `CandleHour` / `CandleDay` where `token = ?` and `periodStart` in range | candle_*(token_id, periodStart) |
| 线三 | `CandleHour` where `periodStart ≥ now − 24h`，跨币 | candle_hour(periodStart) |
| 协议数据页 | `ProtocolDay` where `dayIndex ≥ ?` | protocol_day(dayIndex) |

带两个字段的是复合索引。Envio 的 `@index` 若只支持单字段，单字段索引也能让这些查询命中，复合索引作为 Postgres 上的手工补充，进部署脚本。

### 数据量估算

| 实体 | 行数量级 | 增长 |
|---|---|---|
| `Token` | = 发射的币数，千级 | 每个币一行，只更新不增长 |
| `Trade` | **最大的一张**：币数 × 平均成交笔数；一千个币各几百笔就是几十万行，热门日加几万 | 只增不改，普通索引足够，按月分区暂不需要 |
| `Balance` | 币数 × 持有地址数，十万级 | 只记发射币。配对资产不索引，否则要追全链所有 WETH / USDG 持有者，比发射台自己的事件多几十倍 |
| `CandleMinute` | ≤ 成交笔数，实际远小于 | 只有有成交的分钟才有行 |
| `CandleHour` | 分钟桶的几十分之一 | 同上 |
| `CandleDay` | 币数 × 有成交的天数 | 同上 |
| `Position` | 交易过的（地址 × 币）数，不超过 Balance | 每对一行，只更新 |
| `QuoteAssetConfig` | 配对资产配置的版本数，几十行 | 运营改配置才加 |
| `ProtocolDay` | 天数 × 配对资产数，几千行封顶 | 每天几行 |

Envio 为回滚保留的实体历史表只覆盖 `max_reorg_depth` 那一段，会自动清理，不会跟着主表一起长。

## handler：每个事件做什么

- **QuoteAssetRegistry.QuoteAssetConfigured**（handler）：upsert `QuoteAssetConfig(configHash)`。它就是链上的配对资产名单：精度、初始虚拟储备、毕业阈值、是否启用。
- **LaunchFactory.TokenLaunched**（contractRegister + handler）：`contractRegister` 把 `curve` 加进 BondingCurve、`token` 加进 LaunchToken。建 `Token`：metadata 全部来自事件本身；按 `quoteConfigHash` 取 `QuoteAssetConfig` 填精度、初始储备、阈值；`trackedTokens = TOTAL_SUPPLY`；`pairTokenSymbol` 原生币写 ETH，ERC20 用 Effect 读一次 `symbol()`。
- **BondingCurve.SnipeTaxCharged**（handler）：同 tx 紧接着就是 CurveBuy：把 `amount` 放进 `Token.pendingSnipeTax`，CurveBuy 消费后清零。曲线地址 → 币用 `Token.getWhere.curve.eq(srcAddress)`。
- **BondingCurve.CurveBuy**（handler）：先更新储备：`trackedNetQuote += netQuoteIn`，`trackedTokens −= tokensOut`，由此得成交后边际价。调 `pairPriceAt(pairToken, minute)`。建 `Trade(CURVE_BUY)`：`quoteIn = grossQuoteIn`，`snipeTax = pendingSnipeTax`，剩余 `fee − snipeTax` 按 `curveFeeBps : creatorTaxBps` 拆成 `baseFee` / `creatorTax`（余数归基础费，复现 `_splitBuyFees`），`trader = recipient`。Token 累加 `cumVolumeCurve` / `tradeCount`，set `lastPriceQuote` / `lastTradeAt`；upsert 分钟桶、小时桶、日桶；`ProtocolDay` 累加；`Position` 加数量与成本。
- **BondingCurve.CurveSell**（handler）：`trackedNetQuote −= grossQuoteOut`，`trackedTokens += tokensIn`。建 `Trade(CURVE_SELL)`：`quoteOut = netQuoteOut`，`creatorTax = grossQuoteOut × creatorTaxBps ÷ 10000` 向下取整，`baseFee = fee − creatorTax`，`trader = seller`；`Position` 按均价释放成本，五个 `pnl*` 写回这笔 Trade。其余同买入。
- **LaunchFactory.LaunchSwept**（handler）：`Token.curveClosedAt`。同 tx 的 `CurveCompleted` 不订阅。**不写状态名。**
- **GraduatedPoolHook.PoolRegistered · V4GraduationReceiver.V4PoolGraduated**（handler）：PoolRegistered 先到：set `poolId` / `poolQuoteToken`。V4PoolGraduated：set `poolCreatedAt` / `positionId`，`poolLiquidity = liquidity`，`lastPriceQuote` = 由 `sqrtPriceX96` 换算的池初始价。
- **LaunchFactory.LaunchGraduationRescued**（handler）：set `Token.rescuedAt`。终态，产品口径待定。
- **PoolManager.Swap → GraduatedPoolHook.HookFeeCollected**（handler · 同 tx 两步）：Swap：`Token.getWhere.poolId.eq(id)`，查不到就 return。建 `Trade(POOL_SWAP, trader=null)`，本币是 currency0 还是 currency1 按地址字典序定，`priceQuote` 由 `sqrtPriceX96` 换算；累 `cumVolumePool`，upsert 三种桶的池子列，USD 同上。 HookFeeCollected 紧随其后（在 afterSwap 里发）：`Trade.getWhere.txHash` 找到这笔，回填 `fee` / `creatorTax`；注意 `currency` 可能是本币也可能是配对资产。
- **PoolManager.ModifyLiquidity**（handler）：按 poolId 反查，`Token.poolLiquidity += liquidityDelta`。全区间仓位已永久锁定，正常只会有别人追加。
- **LaunchToken.Transfer**（handler）：`Balance` from 减 to 加，零地址跳过；`to` 为零地址是销毁，`Token.totalSupply −= value`；余额跨过 0 时 `positiveBalanceCount` ±1。**不建 Transfer 实体。** **回填交易者**：`Trade.getWhere.txHash.eq(txHash)` 里找本币、`kind = POOL_SWAP` 的那笔，更新 `trader`：买入时 `to` 不是 PoolManager / TradeRouter / Universal Router 就设为 trader，后到的覆盖先到的；卖出时第一笔 `from` 不是合约的设为 trader。trader 首次确定时同步更新 `Position` 并写回卖出的 `pnl*`。
- **LaunchFactory.CreatorFeeRecipientUpdated · BuybackEnabledUpdated · LiquidityLocker.TokenDustLocked**（handler）：分别 set `creatorFeeRecipient`、`buybackEnabled`，累加 `lockedSupply`。
- **费用类、退款、配置类事件**（空 handler）：FeesDistributed / FeesRescued / PoolFeesSwept / FeeEscrow 四个 / BuybackVault 两个 / CurveBuyRefunded / 工厂配置类：订阅但不建实体，只为让原文进 `raw_events`。费用与税是[第 1 页](/)的 TODO，定了实体再补 handler 重跑。

除取价、ERC20 `symbol()` 两个 Effect 外，handler 只用 `context.X.get / set` 和按索引字段的 `getWhere`，没有随机、没有时间，重放结果确定。每个可变实体写时推进 `updatedAtBlock`。曲线常数 `VIRTUAL_TOKEN_OFFSET`、`TOTAL_SUPPLY` 来自 `LaunchDefaults`，写死在 handler 里；同 tx 内的事件顺序（SnipeTaxCharged → CurveBuy、Swap → HookFeeCollected、Swap → Transfer）以 W1 真实 tx 为准。

## Position 的成本规则：移动平均，每笔卖出结一笔

业内个人页（GMGN、Photon、BullX、pump.fun）的做法一致：移动平均成本，累计买卖值按「钱包 × 币」维护，每笔卖出自带已实现盈亏，「已清仓」靠粉尘阈值在展示层判。我们照这套做，先进先出留给报税软件。

- **买入**：`qtyTraded += tokenOut`，`costQuote += quoteIn`，`costUsd += amountUsd`（缺价时 USD 那份不加，并标记该 Position 的 USD 成本不完整），累计买入三项同步加
- **卖出**：先算 `avg = costQuote ÷ qtyTraded`，释放 `costQuoteReleased = avg × min(tokenIn, qtyTraded)`，超过 `qtyTraded` 的部分成本按 0（那是转进来的币）；`qtyTraded`、`costQuote`、`costUsd` 同比例扣减，累计卖出三项加，`realizedPnl*` 加上这笔的 `pnl*`；这五个 `pnl*` 同时写在这笔 `Trade` 上
- **归零**：`qtyTraded` 恰好回到 0 时 `costQuote` / `costUsd` 一并归 0，下次买入从头算；剩粉尘就带着粉尘那点成本继续，再买时均价自然融合。**不定义「关闭」**，链上卖不干净是常态，「已清仓」是持仓页按粉尘阈值（如持有市值不足一分钱）在读时判的
- **不计入的成交**：`trader` 解不出的池内成交，和 Activity 一致
- **转入转出**：只改 `Balance`，不改 `Position`。持仓页的数量永远显示 `Balance`，成本只来自成交

这是继交易者回填之后第二条进入 handler 的口径。选它进索引层的理由和桶一样：持仓页和历史页都是按地址列一批、要分页，请求时重放该地址全部成交算均价不合适；而且 Envio 会连它一起回滚。成本法要改成先进先出，重跑一遍是分钟级。

## 为什么桶和 USD 都在索引层

::: tip
桶的分钟 / 小时粒度、曲线池子分列都是机械的；USD 按区块时间取价是一条固定规则。两者放 handler 里， **Envio 会连它们一起回滚**，读时不再需要合并价格，Java 也不用拷成交、转账、余额、桶这四类表。 代价是价源换了、取价规则变了要重跑索引，HyperSync 上是分钟级，而且不需要重新部署 Java。

**配对资产余额不走索引层。** 资产页要的是「这一个地址持有多少 WETH / USDG / 股票代币」，几次 `balanceOf` 加一次 `eth_getBalance` 就是准确值；为它索引全链的 WETH 转账不值得，何况原生 ETH 的转账根本不是日志。`Balance` 只记发射币。
:::
