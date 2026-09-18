---
title: 4 · 消息契约：我们要什么字段、为什么要
---

# 消息契约：我们要什么字段、为什么要

这一页是给写 Envio 的同事的需求清单。一条消息 = 一条已解码的合约事件日志 + Envio 解析好的几个字段。每张表三列要看清：**来源**是「原始」还是「解析」——「原始」= ABI 参数原样透传，「解析」= Envio 看了内部状态或整笔交易之后算出来的，**Java 拿不到、也不该自己算**；**必须**列打 ✓ 的缺了 Java 就进 FAILED。

## 一眼看清：哪些字段必须由 Envio 解析

| 解析字段 | 出现在 | Java 为什么不能自己来 |
|---|---|---|
| `token` | CurveBuy · CurveSell · Swap | 曲线事件的 `payload.address` 是 curve、Swap 只有 poolId，`curve → token`、`poolId → token` 的映射只有 Envio 有 |
| `trader` | CurveBuy · CurveSell · Swap | 要看整笔交易里本币 Transfer 的净流量才能穿透路由 / 中继；Java 单看一条消息看不到整笔 tx |
| `baseFee` `creatorTax` `snipeTax` | CurveBuy · CurveSell | 拆分规则是合约代码（`_splitBuyFees`、卖出税率）；反狙击税在另一条事件里 |
| `quoteReserve` `tokenReserve` `priceQuote` | CurveBuy · CurveSell | 曲线定价公式和常数是合约的；Java 里不许有合约数学 |
| `quoteDecimals` `graduationQuoteThreshold` `initialVirtualQuoteReserve` `totalSupply` | TokenLaunched | 前三个要按 `quoteConfigHash` 查链上注册表；总供应是合约常数 |
| `priceQuote` | V4PoolGraduated · Swap | `sqrtPriceX96` 换算与 currency0 / 1 方向是 Uniswap 数学 |
| `side` `tokenAmount` `quoteAmount` | Swap | `amount0` / `amount1` 哪个是本币要按地址大小判 |
| `hookFee` `creatorTax` `feeCurrency` | Swap | 在同 tx 的 `HookFeeCollected` 里，Envio 合并 |
| `fromBalance` `toBalance` `totalSupply` `positiveBalanceCount` | Transfer | ERC20 余额语义；Java 只 set 绝对值、不累加 |

## topic 与投递

| 项 | 值 |
|---|---|
| topic | `launchpad.chain.event`，只有这一条 |
| key | token 地址（小写）；`QuoteAssetConfigured` 用 asset 地址 |
| 顺序 | 同一 key 内严格按 `(blockNumber, logIndex)`；跨 key 不保证 |
| 投递 | 至少一次；Java 按 `eventId` 去重 |
| 编码 | JSON，UTF-8；uint / int 一律**十进制字符串**；地址、哈希、bytes32 一律 **`0x` 小写**；bool 用 JSON 布尔；string 原样；struct 展开成对象 |
| 事件名 | ABI 名，不起别名；`args` 字段名 = ABI 参数名 |

## 信封：每条消息都要

```json
{
  "eventId": "v1:4663:0x3fe5…30d6:17:false",
  "eventName": "CurveBuy",
  "chainId": "4663",
  "blockNumber": "1234567",
  "blockHash": "0x3fe5…30d6",
  "blockTimestamp": "1789014626",
  "logIndex": "17",
  "txHash": "0x590d…8848",
  "txFrom": "0x2bf5…7675",
  "removed": false,
  "payload": {
    "address": "0xc721…3a1a",
    "signature": "CurveBuy(address,address,uint128,uint128,uint96,uint128)",
    "args": { "…": "ABI 具名参数，原样" },
    "derived": { "…": "Envio 解析的字段，各事件不同" }
  }
}
```

| 字段 | 必须 | 含义 | 我们为什么要 |
|---|---|---|---|
| `eventId` | ✓ | `v1:{chainId}:{blockHash}:{logIndex}:{removed}`，`v1` 是契约版本 | 审计表唯一键；至少一次投递靠它去重；重放按它定位 |
| `eventName` | ✓ | ABI 事件名 | 路由到 handler |
| `chainId` | ✓ | EVM chain id，十进制字符串 | 所有表的 `chain_id` 列 |
| `blockNumber` | ✓ | 区块高度 | 同币事件的顺序；按区块区间重放；余额乱序保护 |
| `blockHash` | ✓ | 区块哈希 | `eventId` 的组成部分；审计 |
| `blockTimestamp` | ✓ **非 0** | 区块时间，秒 | 成交时间、K 线分桶、发币时间排序、**按区块时间取配对资产价格固化 USD**。Java 没有查区块的兜底，缺了整条消息作废 |
| `logIndex` | ✓ | 日志在区块中的序号 | 成交表唯一键 `(tx_hash, log_index)`；同 tx 内的顺序 |
| `txHash` | ✓ | 交易哈希 | 成交表唯一键；前端跳区块浏览器 |
| `txFrom` | ✓ | 交易发起人（Envio 要开 `transaction_fields: [from]`） | 备查列，排查中继 / 路由问题时用 |
| `removed` | ✓ | 恒 `false` | 语义保留，Java 收到 `true` 只留审计不投影 |
| `payload.address` | ✓ | 发出日志的合约地址 | Transfer 时它就是 token；其余作审计 |
| `payload.signature` | ✓ | 规范签名 | 区分同名重载；审计 |
| `payload.args` | ✓ | ABI 具名参数原样 | 链上事实 |
| `payload.derived` | 按事件 | Envio 解析的字段 | 见各事件 |

## 十种事件

### QuoteAssetConfigured（QuoteAssetRegistry）

Java 写 `launchpad_quote_asset`（键 `config_hash`）。这是配对资产精度、毕业阈值的链上权威，Java 不再靠运营名单认精度。

| 字段 | 来源 | 必须 | 含义 | 我们为什么要 |
|---|---|---|---|---|
| `asset` | 原始 | ✓ | 配对资产地址，零地址 = 原生 ETH | 按地址关联运营名单（代号、图标、价源） |
| `configHash` | 原始 | ✓ | 这份配置的哈希 | `TokenLaunched.quoteConfigHash` 指向它；一份配置一行 |
| `decimals` | 原始 | ✓ | 配对资产精度 | 所有配对资产金额换整枚；USDG(6) 猜成 18 会差 10¹² |
| `graduationQuoteThreshold` | 原始 | ✓ | 毕业阈值，最小单位 | 进度条分母（也会随 TokenLaunched 的 derived 再给一次） |
| `initialVirtualQuoteReserve` | 原始 | ✓ | 曲线初始虚拟储备 | 核对 Envio 算出的价格；存档 |
| `enabled` | 原始 | ✓ | 当前是否允许新发币选它 | 运营名单缺价源时告警的对照 |
| `version` `targetNetGraduationQuote` `sourcePriceTimestamp` | 原始 | — | 模板版本 / 目标募集额 / 校准时间 | 存档，不参与任何计算 |

### TokenLaunched（LaunchFactory）

Java 插入 `launchpad_token`，解析 `socials.storyFun` 绑叙事，反查发行者用户。

| 字段 | 来源 | 必须 | 含义 | 我们为什么要 |
|---|---|---|---|---|
| `token` | 原始 | ✓ | 发射币地址 | 币的主键；Kafka key |
| `curve` | 原始 | ✓ | 曲线合约地址 | 持有者榜标「Bonding Curve」行；审计对照 |
| `creator` | 原始 | ✓ | 发币人 | 反查平台用户；Launches 页签；OG；发行者持仓警示 |
| `quoteAsset` | 原始 | ✓ | 配对资产地址 | 金额计价单位；取 USD 用哪个价；协议日按它分组 |
| `quoteConfigHash` | 原始 | ✓ | 指向 QuoteAssetConfigured | 关联精度与阈值 |
| `launchConfigId` `curveFeeBps` `tickSpacing` | 原始 | ✓ | 发射配置 id / 基础费率 / 池 tick | 存档；费率给详情页展示 |
| `creatorTaxBps` | 原始 | ✓ | 创作者税 BPS，不可变 | 详情页展示；核对 derived 的费用拆分 |
| `creatorFeeRecipient` `buybackEnabled` | 原始 | ✓ | 发币时的收款人 / 回购开关 | 存档，不追更新 |
| `name` `symbol` `logo` `description` | 原始 | ✓ | metadata | 卡片、详情、搜索、OG 键 |
| `socials.storyFun` | 原始 | ✓ | Story.Fun 发射页 URL | **叙事绑定的唯一依据**：解析 `/drama/{id}` 或 `/video/{id}` |
| `socials.website` `twitter` `telegram` `discord` `farcaster` | 原始 | ✓（可空串） | 社交链接 | 详情页展示 |
| `launchSalt` | 原始 | — | CREATE2 salt | 存档 |
| `quoteDecimals` | **解析** | ✓ | 配对资产精度 | 落币行，成交换算全靠它；Java 不查注册表 |
| `graduationQuoteThreshold` | **解析** | ✓ | 毕业阈值 | 进度条分母 |
| `initialVirtualQuoteReserve` | **解析** | ✓ | 初始虚拟储备 | 存档、核对 |
| `totalSupply` | **解析** | ✓ | 总供应，合约常数 1e9 × 1e18 | 市值 = 价 × 它；持有占比分母；Java 不写合约常数 |

```json
"args": {
  "token": "0x3d7e…4cdd", "curve": "0x73d4…31eb", "creator": "0x2bf5…7675",
  "launchSalt": "0x…", "quoteAsset": "0x0000000000000000000000000000000000000000",
  "quoteConfigHash": "0xab…", "launchConfigId": "1", "curveFeeBps": "100", "tickSpacing": "60",
  "creatorFeeRecipient": "0x2bf5…7675", "creatorTaxBps": "50", "buybackEnabled": false,
  "name": "Loxley", "symbol": "LOX", "logo": "https://…/lox.png", "description": "…",
  "socials": { "website": "", "twitter": "", "telegram": "", "discord": "", "farcaster": "",
               "storyFun": "https://story.fun/drama/1024" }
},
"derived": { "quoteDecimals": "18", "initialVirtualQuoteReserve": "1000000000000000000",
             "graduationQuoteThreshold": "4000000000000000000", "totalSupply": "1000000000000000000000000000" }
```

### CurveBuy（BondingCurve）

Java 写 `launchpad_trade`（CURVE / BUY）、持仓、K 线桶、协议日；币行 set 储备、价格、最近成交。

| 字段 | 来源 | 必须 | 含义 | 我们为什么要 |
|---|---|---|---|---|
| `buyer` | 原始 | ✓ | 调曲线的地址（经路由时是路由） | 成交行的对手方；排查 |
| `recipient` | 原始 | ✓ | 收币地址 | 名义交易者 |
| `grossQuoteIn` | 原始 | ✓ | 用户实付的配对资产，含全部费税、不含退款 | **成交额**（`quote_amount`）、USD、24h 量 |
| `netQuoteIn` | 原始 | ✓ | 进入定价储备的部分 | 均价 `avg_price_quote`（持仓成本用） |
| `tokensOut` | 原始 | ✓ | 用户拿到的本币 | 成交数量；持仓数量 |
| `fee` | 原始 | ✓ | 费用总额 | 存档；核对拆分之和 |
| `token` | **解析** | ✓ | 这条曲线对应的发射币 | 消息里只有 curve 地址；所有表按 token 关联 |
| `trader` | **解析** | ✓ | 真实交易者 | Activity、持仓、持有者归属都按它；穿透规则见[第 3 页](/envio) |
| `baseFee` `creatorTax` `snipeTax` | **解析** | ✓（无则 `"0"`） | `fee` 拆成基础费 / 创作者税 / 反狙击税 | 详情页费用展示；反狙击税在同 tx 另一条事件里 |
| `quoteReserve` | **解析** | ✓ | 成交后曲线净募集 | **毕业进度分子**（对外 `quoteRaised`）；流动性 |
| `tokenReserve` | **解析** | ✓ | 成交后曲线库存 | 存档、核对 |
| `priceQuote` | **解析** | ✓ | 成交后边际价，一枚本币值多少配对资产 | **币价**、K 线、市值 |

```json
"payload": {
  "address": "0x73d4…31eb",
  "signature": "CurveBuy(address,address,uint128,uint128,uint96,uint128)",
  "args": { "buyer": "0x096a…4fd4", "recipient": "0x2bf5…7675",
            "grossQuoteIn": "100000000000000", "netQuoteIn": "99000000000000",
            "tokensOut": "714285714285714285714285715", "fee": "1000000000000" },
  "derived": { "token": "0x3d7e…4cdd", "trader": "0x2bf5…7675",
               "baseFee": "666666666667", "creatorTax": "333333333333", "snipeTax": "0",
               "quoteReserve": "99000000000000", "tokenReserve": "285714285714285714285714285",
               "priceQuote": "0.000000000000140" }
}
```

### CurveSell（BondingCurve）

Java 写 `launchpad_trade`（CURVE / SELL），持仓结一笔已实现盈亏，其余同买入。

| 字段 | 来源 | 必须 | 含义 | 我们为什么要 |
|---|---|---|---|---|
| `seller` | 原始 | ✓ | 卖币地址 | 名义交易者 |
| `recipient` | 原始 | ✓ | 收款地址 | 对手方 |
| `tokensIn` | 原始 | ✓ | 卖出的本币 | 成交数量；持仓扣减 |
| `grossQuoteOut` | 原始 | ✓ | 离开定价储备的配对资产，扣费前 | 均价 |
| `netQuoteOut` | 原始 | ✓ | 用户实收 | **成交额**、USD、盈亏 |
| `fee` | 原始 | ✓ | 费用总额 | 存档 |
| `token` `trader` `quoteReserve` `tokenReserve` `priceQuote` | **解析** | ✓ | 同 CurveBuy | 同 CurveBuy |
| `baseFee` `creatorTax` | **解析** | ✓ | 卖出无反狙击税 | 费用展示 |

### LaunchSwept（LaunchFactory）

Java 写币行 `curve_closed_at` / `swept_quote` / `swept_token`，`status = GRADUATED`。

| 字段 | 来源 | 必须 | 含义 | 我们为什么要 |
|---|---|---|---|---|
| `token` | 原始 | ✓ | 发射币 | 定位币行；同 tx 的 `CurveCompleted` 没有它，所以订这条 |
| `quoteAmount` `tokenAmount` | 原始 | ✓ | 交给毕业流程的配对资产 / 本币 | 详情页「毕业时募集」；存档 |

### V4PoolGraduated（V4GraduationReceiver）

Java 写币行 `pool_created_at` / `pool_id` / `pool_position_id` / `pool_liquidity` / `price_quote`。

| 字段 | 来源 | 必须 | 含义 | 我们为什么要 |
|---|---|---|---|---|
| `token` | 原始 | ✓ | 发射币 | 定位币行 |
| `poolId` | 原始 | ✓ | Uniswap v4 poolId | 前端拼 Uniswap 链接；与 Swap 对照 |
| `positionId` | 原始 | ✓ | 锁定的 LP NFT id | 存档、前端链接 |
| `liquidity` | 原始 | ✓ | 初始流动性 | `liquidity_usd`（若做） |
| `quoteAmount` `tokenAmount` | 原始 | ✓ | 迁入池的两侧数量 | 存档 |
| `sqrtPriceX96` `curve` `tokenDust` `quoteDust` | 原始 | — | 原值 | 存档 |
| `priceQuote` | **解析** | ✓ | 池初始价，一枚本币值多少配对资产 | 建池到第一笔 Swap 之间的币价 |

### PoolRegistered（GraduatedPoolHook）

Java 写币行 `pool_id` / `pool_quote_asset`（与 V4PoolGraduated 谁先到谁写）。

| 字段 | 来源 | 必须 | 含义 | 我们为什么要 |
|---|---|---|---|---|
| `poolId` `token` `quoteAsset` | 原始 | ✓ | 池 id、发射币、池的计价资产 | 核对池的配对资产 = 发币时的 quoteAsset |

### LaunchGraduationRescued（LaunchFactory）

Java 写币行 `rescued_at`，`status = RESCUED`。

| 字段 | 来源 | 必须 | 含义 | 我们为什么要 |
|---|---|---|---|---|
| `token` | 原始 | ✓ | 发射币 | 定位币行 |
| `recipient` `quoteAmount` `tokenAmount` | 原始 | ✓ | 储备释放给谁、多少 | 存档；展示口径待产品定 |

### Swap（PoolManager，只发我们的池）

Java 写 `launchpad_trade`（POOL）、持仓、K 线桶、协议日；币行 set 价格、流动性、最近成交。

| 字段 | 来源 | 必须 | 含义 | 我们为什么要 |
|---|---|---|---|---|
| `id` | 原始 | ✓ | poolId | 存档；与币行 `pool_id` 对照 |
| `sender` | 原始 | ✓ | 调 PoolManager 的地址（路由） | 对手方；排查 |
| `amount0` `amount1` `sqrtPriceX96` `liquidity` `tick` `fee` | 原始 | ✓ | Uniswap 原值 | 存档、核对 derived；`liquidity` 给 `liquidity_usd`（若做） |
| `token` | **解析** | ✓ | 这个池对应的发射币 | 消息里只有 poolId |
| `side` | **解析** | ✓ | BUY / SELL | 本币是 currency0 还是 currency1 要按地址大小判，Java 不做 |
| `trader` | **解析** | ✓（可为 null） | 真实交易者 | Activity、持仓；null 的成交照记但不进 Activity |
| `tokenAmount` `quoteAmount` | **解析** | ✓ | 本币 / 配对资产的绝对数量 | 成交数量、成交额、USD |
| `priceQuote` | **解析** | ✓ | 成交后池价 | **毕业后的币价**、K 线、市值 |
| `hookFee` `creatorTax` `feeCurrency` | **解析** | ✓（无则 `"0"`） | 同 tx `HookFeeCollected` 的费用与计价币 | 费用展示；`feeCurrency` 可能是本币也可能是配对资产 |

```json
"payload": {
  "address": "0xpoolmanager…",
  "signature": "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
  "args": { "id": "0x1dcf…a049", "sender": "0xrouter…", "amount0": "-2500000000000000",
            "amount1": "18000000000000000000000", "sqrtPriceX96": "…", "liquidity": "…", "tick": "-201234", "fee": "3000" },
  "derived": { "token": "0x3d7e…4cdd", "side": "BUY", "trader": "0x944…",
               "tokenAmount": "18000000000000000000000", "quoteAmount": "2500000000000000",
               "priceQuote": "0.000000000000138", "hookFee": "24999843", "creatorTax": "0",
               "feeCurrency": "0x0000000000000000000000000000000000000000" }
}
```

### Transfer（LaunchToken，只发发射币）

Java 把 `launchpad_balance` 两行 set 成消息里的绝对值；币行 set `total_supply` / `holder_count`。**不累加**，所以重放、重复投递无副作用；同币消息有序是前提。

| 字段 | 来源 | 必须 | 含义 | 我们为什么要 |
|---|---|---|---|---|
| `from` `to` `value` | 原始 | ✓ | 转账三要素 | 审计；`to` 为零地址 = 销毁 |
| `fromBalance` | **解析** | ✓（from 为零地址时 null） | 转出方**转账后**的余额 | 直接 set 余额表；Java 不做加减 |
| `toBalance` | **解析** | ✓（to 为零地址时 null） | 转入方**转账后**的余额 | 同上 |
| `totalSupply` | **解析** | ✓ | 这笔之后的总供应 | 销毁后市值分母跟着减 |
| `positiveBalanceCount` | **解析** | ✓ | 这笔之后余额 > 0 的地址数，含合约 | 持有人数（读时再剔曲线 / PoolManager） |

```json
"payload": {
  "address": "0x3d7e…4cdd",
  "signature": "Transfer(address,address,uint256)",
  "args": { "from": "0x73d4…31eb", "to": "0x2bf5…7675", "value": "714285714285714285714285715" },
  "derived": { "fromBalance": "285714285714285714285714285", "toBalance": "714285714285714285714285715",
               "totalSupply": "1000000000000000000000000000", "positiveBalanceCount": "2" }
}
```

一笔曲线买入至少带出一条 Transfer（curve → 用户），经路由时两条；这是消息量的大头。

## 不发的事件

| 事件 | 原因 |
|---|---|
| `SnipeTaxCharged` `HookFeeCollected` | 已合并进 CurveBuy / Swap 的 `derived` |
| `CurveBuyRefunded` | 退款不含在 `grossQuoteIn` 里，不影响任何数 |
| `TradeRouter.Launched` | 与同 tx 的首买 CurveBuy 重复 |
| `CurveCompleted` `LaunchGraduated` | 与 LaunchSwept / V4PoolGraduated 同 tx 信息重叠 |
| `ModifyLiquidity` | 只为 `liquidity_usd`，待定（[第 10 页](/rollout)） |
| `CreatorFeeRecipientUpdated` `BuybackEnabledUpdated` `TokenDustLocked` | 当前接口不出这些字段 |
| 费用 / 回购 / 治理类 | 本期不做费用区；留 `raw_events`，要用时加 handler 重扫 |

## 兼容规则

- `eventName` = ABI 名，`args` 字段名 = ABI 参数名，Envio 不改名；`derived` 字段名以本页为准
- 加字段不算破坏；改名、删字段、改类型要换 `eventId` 前缀版本（`v1` → `v2`）并双写一段时间
- Java 的 `ChainEventParser` 只校验信封；`args` / `derived` 由各 handler 用 `requireArg` 取，本页打 ✓ 的缺了进 FAILED
