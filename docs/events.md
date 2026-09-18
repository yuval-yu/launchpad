---
title: 9 · 15 个合约、哪些事件订阅、各发什么消息
---

# 15 个合约、哪些事件订阅、各发什么消息

合约源码在 workspace 根 `src/`，共 15 个合约。这一页写清**每个事件订不订阅、订阅后发不发消息**。消息字段见[第 4 页](/messages)。

## 合约总览：15 个合约各管什么

源码在 `src/`。「部署方式」决定 Envio 怎么订阅：固定地址写进 config，每个发射各一份的用 `contractRegister` 动态注册。

| 合约 | 职责 | 部署方式 | Envio |
|---|---|---|---|
| **LaunchFactory** | 发币入口；部署并初始化 token 与 curve；两阶段毕业的编排（closeCurve → graduate）；创作者收款人、回购开关、发射配置、反狙击税参数的治理 | 固定，一个 | **订阅** |
| **BondingCurve** | 一个发射一份的常数乘积曲线，按发币时快照的配对资产计价；买卖、费用累计、反狙击税、卖完自动触发关闭 | CREATE2 clone，每个发射一份 | **订阅，动态注册** |
| **LaunchToken** | 固定供应 10 亿枚、18 位精度的 ERC20 clone，一次性铸给 curve；带 EIP-2612、可自愿销毁；metadata 与 socials 存在合约里也复制进发币事件 | CREATE2 clone，每个发射一份 | **订阅，动态注册**（Transfer） |
| **TradeRouter** | 发币并首买、直接买、经 Universal Router 换成配对资产再买。**没有卖出入口**，卖是直接对 curve | 固定，一个 | 不订阅；它的地址要给 trader 穿透时排除 |
| **QuoteAssetRegistry** | 允许哪些配对资产发币及各自的曲线经济参数（精度、初始虚拟储备、毕业阈值）；只影响新发币 | 固定，一个 | **订阅** |
| **V4GraduationReceiver** | 毕业第二阶段：收下工厂送来的储备，初始化 Uniswap v4 池、铸全区间仓位并交给 Locker | 固定，一个 | **订阅** |
| **GraduatedPoolHook** | 毕业池的 v4 hook：只允许 Receiver 建池，每笔 swap 后按「未指定方向」那一侧收基础费与创作者税，定期清扫分给协议 / 回购 / 创作者 | 固定，一个（HookDeployer 部署） | **订阅** |
| **PoolManager**（Uniswap v4 核心） | 所有 v4 池的单例；毕业后成交与流动性变更事件由它发出 | 固定，不在 `src/` | **订阅**，handler 按 poolId 过滤，只发我们池的 |
| **LiquidityLocker** | 永久持有毕业池的 Position NFT 与铸币尾数；没有任何取出函数 | 固定，一个 | 订阅，不发消息 |
| **FeeEscrow** | 共享的可领取台账：曲线、hook、vault 把费用记到收款人名下（按资产），收款人自己领 | 固定，一个 | 订阅，空 handler，只留档 |
| **FeePolicy** | 协议费拆分政策与清扫操作员；每个发射在创建时冻结一份快照 | 固定，一个 | 不订阅；快照进了发币事件与 curve |
| **BuybackVault** | 锁住回购来的发射币，5 年线性释放给创作者与协议（经 FeeEscrow） | 固定，一个 | 订阅，空 handler，只留档 |
| **Quoter** | 只读报价聚合，给前端下单前算数用 | 固定，一个 | 不订阅，无事件 |
| **CurveDeployer / TokenDeployer** | CREATE2 部署 curve / token clone；换实现只影响之后的发射 | 固定，各一个 | 不订阅；`ImplementationUpdated` 可作「合约升级」告警源 |
| **HookDeployer** | 按确定性地址部署 hook | 固定，一个 | 不订阅 |

库：`LaunchDefaults`（总供应、可售量、虚拟储备偏移、tick spacing 等常数，handler 要写死一份）、`BondingCurveMath`（常数乘积公式）、`GraduationMath`、`CurveConfigurationMath`、`FeePolicyLimits`。

## Envio 订阅清单

一张表说清 config 里要写什么。「发」= handler 解码后发 Kafka；「合并」= 不单独发，并进同 tx 另一条消息的 `derived`；「留档」= 订阅但空 handler，只进 `raw_events`；没列的事件不订阅。

| 合约 | 地址 | 事件 | 处理 |
|---|---|---|---|
| **LaunchFactory** | 固定 | TokenLaunched · LaunchGraduationRescued | 发 |
| 〃 | 〃 | LaunchSwept | 不发（与曲线的 CurveCompleted 同 tx 等价，扫链发的是后者） |
| 〃 | 〃 | CreatorFeeRecipientUpdated · BuybackEnabledUpdated | 留档（当前接口不出这两个字段） |
| 〃 | 〃 | LaunchConfigAdded · LaunchConfigUpdated · LaunchFeeUpdated · LaunchEnabledUpdated · SnipeTaxUpdated · MaxCreatorTaxUpdated · CreatorFeeRecipientChangeProposed · CreatorFeeRecipientChangeCancelled · AllowlistedLauncherUpdated | 空 |
| 〃 | 〃 | LaunchGraduated · LaunchForwarderUpdated · ProtocolConfigured · DeployersConfigured | 不订阅 |
| **BondingCurve** | 动态：TokenLaunched.curve | CurveBuy · CurveSell · CurveCompleted | 发 |
| 〃 | 〃 | SnipeTaxCharged | 留档（费用拆分本期不做） |
| 〃 | 〃 | CurveBuyRefunded · FeesDistributed · FeesRescued · GraduationFeesDeferred · BuybackLocked · SnipeTaxExempted · AutoGraduationFailed | 空 |
| 〃 | 〃 | CurveCompleted | 发（曲线关闭 = 毕业） |
| 〃 | 〃 | Initialized · CreatorFeeRecipientUpdated · BuybackEnabledUpdated | 不订阅（与工厂事件重复） |
| **LaunchToken** | 动态：TokenLaunched.token | Transfer | 发 |
| **QuoteAssetRegistry** | 固定 | QuoteAssetConfigured | Envio 自存，不发（给 TokenLaunched 补精度 / 阈值） |
| **V4GraduationReceiver** | 固定 | V4PoolGraduated | 发（Dust 四个事件不订阅） |
| **GraduatedPoolHook** | 固定 | PoolRegistered | 发 |
| 〃 | 〃 | HookFeeCollected | 留档（费用拆分本期不做） |
| 〃 | 〃 | PoolFeesSwept · PoolFeesRescued · PoolBuybackSkipped · PoolConversionSkipped | 空 |
| 〃 | 〃 | ReceiverConfigured · CreatorFeeRecipientUpdated · BuybackEnabledUpdated | 不订阅 |
| **PoolManager** | 固定，v4 核心 | Swap | 发，按 poolId 过滤，其它池丢弃 |
| 〃 | 〃 | ModifyLiquidity | 不订阅（池侧储备随下一笔 Swap 更新） |
| **LiquidityLocker** | 固定 | TokenDustLocked · PositionLocked | 留档 |
| **FeeEscrow** | 固定 | Credited · CreditedToken · Claimed · ClaimedToken | 留档 |
| **BuybackVault** | 固定 | Locked · Released · VestingTermsSnapshotted · CreatorRecipientUpdated | 留档 |
| **TradeRouter** | 固定 | Launched · Rescued | 不订阅。Launched 与首买 CurveBuy 重复 |
| **Deployer 三个 · FeePolicy · Quoter** | 固定 | — | 不订阅 |

`field_selection` 要 `transaction_fields: [hash, from]`；`raw_events: true`。空 handler 的事件全靠 `raw_events` 留原文。

## 源码核实的结论

- **metadata 在发币事件里。** `TokenLaunched` 直接带 name / symbol / logo / description / socials，不需要取 URI
- **socials 里有专门的 `storyFun` 字段**，注释是「Story.Fun profile or launch page URL」。叙事绑定应该解析它，`website` 只是普通官网
- **退款不含在成交额里。** `CurveBuy.grossQuoteIn` 的注释明写「excluding any refund」，`CurveBuyRefunded` 只在终局买入、多付的部分原路退回时发。不用扣
- **买卖双方分开。** `CurveBuy(buyer, recipient, …)`、`CurveSell(seller, recipient, …)`；经 TradeRouter 买时 buyer 是路由、recipient 是用户，「买入取 recipient」这条规则成立
- **成交后价格可以从事件精确推出。** 曲线是常数乘积，定价储备 = `initialVirtualQuoteReserve + trackedNetQuote` 与 `VIRTUAL_TOKEN_OFFSET + trackedTokens`，两个 tracked 值就是买入 `netQuoteIn`、卖出 `grossQuoteOut`、进出代币量的累加，常数在 `LaunchDefaults` 里
- **费用拆分可复现。** 买入 `fee` = 基础费 + 创作者税 + 反狙击税，按 `_splitBuyFees` 的费率比例分，反狙击税另有 `SnipeTaxCharged` 事件给出精确值；卖出创作者税 = `grossQuoteOut × creatorTaxBps ÷ 10000` 向下取整
- **配对资产是链上注册的。** `QuoteAssetRegistry` 只允许已配置的资产发币，`QuoteAssetConfigured` 事件给出 decimals、初始虚拟储备、毕业阈值和 `configHash`，`TokenLaunched.quoteConfigHash` 指向它。精度和阈值都从事件取
- **供应固定 10 亿枚、18 位精度**，可自愿销毁（Transfer 到零地址），市值用的总供应要跟着减
- **没有持有人分红。** `BuybackVault` 把回购的币按 5 年线性释放给创作者与协议，不是给持有人

## 订阅并发消息的事件

| 合约 · 事件 | 参数 | Envio 补的 derived | Java 落到哪 |
|---|---|---|---|
| **LaunchFactory.TokenLaunched** | token, curve, creator, launchSalt, quoteAsset, quoteConfigHash, launchConfigId, curveFeeBps, tickSpacing, creatorFeeRecipient, creatorTaxBps, buybackEnabled, name, symbol, logo, description, socials | initialVirtualQuoteReserve, graduationQuoteThreshold | `launchpad_token` 插入；`storyFun` 绑叙事 |
| **BondingCurve.CurveBuy** | buyer, recipient, grossQuoteIn, netQuoteIn, tokensOut, fee | quoteReserve, priceQuote；trader 可选（名义地址是合约时才给） | `launchpad_trade`；币行储备 / 价格；position / kline / protocol_day |
| **BondingCurve.CurveSell** | seller, recipient, tokensIn, grossQuoteOut, netQuoteOut, fee | 同上 | 同上，position 结一笔已实现盈亏 |
| **BondingCurve.CurveCompleted** | recipient, quoteAmount, tokenAmount + token.token | — | 币行 `curve_closed_at` / `swept_quote` / `swept_token`，status = GRADUATED |
| **GraduatedPoolHook.PoolRegistered** | poolId, token, quoteAsset | — | 币行 `pool_id` |
| **V4GraduationReceiver.V4PoolGraduated** | token, curve, poolId, positionId, sqrtPriceX96, liquidity, quoteAmount, tokenAmount, tokenDust, quoteDust | priceQuote（池初始价）, liquidityQuote | 币行 `pool_created_at` / `pool_id` / `price_quote` |
| **LaunchFactory.LaunchGraduationRescued** | token, recipient, quoteAmount, tokenAmount | — | 币行 `rescued_at`，status = RESCUED。**产品要定这种币怎么展示** |
| **PoolManager.Swap**（v4 核心，只发我们的池） | id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee | side, trader（必须）, tokenAmount, quoteAmount, priceQuote, liquidityQuote | `launchpad_trade`（POOL）；币行 `price_quote` / `pool_liquidity` |
| **LaunchToken.Transfer** | from, to, value | fromBalance, toBalance, totalSupply, positiveBalanceCount（变动后绝对值） | `launchpad_balance` set；币行 `total_supply` / `holder_count` set |

同 tx 不需要配对：费用拆分本期不做，每种成交事件各自独立发。

## 订阅、空 handler、只进 raw_events（不发消息）

费用与税本期不做。这些事件订阅但空 handler，原文留在 Envio 的 `raw_events`；要用时加 handler 重扫并发消息。

| 合约 · 事件 | 将来给谁 |
|---|---|
| **BondingCurve.FeesDistributed**(protocolAmount, buybackAmount, creatorAmount) · **FeesRescued** · **GraduationFeesDeferred** · **BuybackLocked**(quoteSpent, tokensLocked) | 按币的曲线阶段费用汇总 |
| **GraduatedPoolHook.PoolFeesSwept**(poolId, protocolAmount, buybackSpent, creatorAmount, tokensLocked, retainedTokenFees) · **PoolFeesRescued** | 按币的毕业后费用汇总 |
| **FeeEscrow.Credited**(recipient, depositor, amount) · **CreditedToken**(recipient, token, depositor, amount) · **Claimed**(recipient, amount) · **ClaimedToken**(recipient, token, amount) | 按收款人 × 资产的可领取 / 已领取台账 |
| **BuybackVault.Locked** · **Released**(token, creatorAmount, protocolAmount) · **VestingTermsSnapshotted** · **CreatorRecipientUpdated** | 回购锁仓与 5 年释放 |
| **BondingCurve.CurveBuyRefunded**(buyer, refund) · **SnipeTaxExempted** · **AutoGraduationFailed** | 排查 |
| **LaunchFactory** 的 LaunchConfigAdded / Updated · LaunchFeeUpdated · LaunchEnabledUpdated · SnipeTaxUpdated · MaxCreatorTaxUpdated · CreatorFeeRecipientChangeProposed / Cancelled · AllowlistedLauncherUpdated | 配置审计 |
| **LiquidityLocker.PositionLocked**(token, positionId) | 与 V4PoolGraduated 重复，留档 |

## 不订阅

- **TradeRouter.Launched**(token, curve, recipient, launcher, quoteSpent, tokensReceived)：发射首买的重复表述，同 tx 里已有一条 CurveBuy
- **TradeRouter.Rescued**、**V4GraduationReceiver** 的四个 Dust 事件、**BondingCurve.Initialized**、各 Deployer 的 **CloneDeployed** / **ImplementationUpdated**、**HookDeployed**、各 **ReceiverConfigured** / **FactoryConfigured** / **ProtocolConfigured** / **DeployersConfigured**：部署期与运维事件，与数据无关
- **LaunchFactory.LaunchSwept**、**LaunchFactory.LaunchGraduated**：与 CurveCompleted、V4PoolGraduated 同 tx 且信息重叠，各取一条即可
- **曲线与 Hook 各自的 CreatorFeeRecipientUpdated / BuybackEnabledUpdated**：工厂那份带 token，够用

## 一个币的生命周期

| 合约状态 | 进入的事件 | 我们的 `status` | 说明 |
|---|---|---|---|
| `Trading` | TokenLaunched | CURVE | 曲线可买卖；卖完可售库存后自动尝试 closeCurve，失败发 AutoGraduationFailed，可重试 |
| `Swept` | CurveCompleted（同 tx LaunchSwept） | GRADUATED | 储备进工厂，等 graduate。**「曲线一关就算毕业」落在这里** |
| `Graduated` | V4PoolGraduated（同 tx PoolRegistered、LaunchGraduated、PositionLocked） | GRADUATED | 池建好、全区间流动性永久锁定；此后成交来自 PoolManager.Swap |
| `Rescued` | LaunchGraduationRescued | **待定** | Swept 超过 7 天没能建池，治理把储备释放给指定地址。终态，没有池。**展示口径待定（[第 10 页](/rollout) Q5）**，去问合约与产品 |

## 还要问清的五件事

- **各合约部署地址与区块号**：主网与测试网各一份；PoolManager 是 Uniswap v4 核心合约，地址也要
- **路由地址**：TradeRouter 与 Universal Router，Transfer 回填交易者时要排除；前端是否还有别的下单路径
- **`@index` 与 `getWhere` 的实际能力**：复合索引支不支持、同一区块内刚写的实体能否被 `getWhere` 查到。（本期没有同 tx 配对，暂不关键）
- **QuickNode 的限流与回填速度**：主网与测试网都纯 RPC，`eth_getLogs` 按地址过滤，动态注册的合约越多每批请求越重；全量回填一次要多久、追块的请求频率占不占额度，W1 实测
- **合约升级怎么通知**：clone 实现可换（`ImplementationUpdated`），事件签名一变 handler 收不到，Envio 不报错。可以顺手订阅 Deployer 的 ImplementationUpdated 当告警源
