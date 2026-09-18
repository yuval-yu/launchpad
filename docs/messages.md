---
title: 4 · 消息契约：我们要什么字段、为什么要
---

# 消息契约：我们要什么字段、为什么要

这一页是给写 Envio 的同事的需求清单。一条消息 = 一条已解码的合约事件日志 + Envio 解析好的几个字段。每个事件一张表，左边字段、右边含义与说明；说明里统一用三个标记：

- **【原始】** ABI 参数原样透传；**【解析】** Envio 看了内部状态或整笔交易之后算出来的，Java 拿不到、也不该自己算
- **【必须】** 缺了 Java 进 FAILED；**【可选】** 只存档，缺了不影响
- 后面一句是我们拿它做什么

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
| `fromKind` `toKind` | Transfer | 哪些地址是曲线 / PoolManager / 工厂 / Receiver / Locker / 路由，只有 Envio 的 config 里有这份地址表；Java 靠它给持有者榜标「Bonding Curve」、剔除协议合约 |
| `tokenDecimals` `quoteSymbol` | TokenLaunched | 前者是合约常数；后者要 `symbol()` 读链 |

## topic 与投递

| 项 | 值 |
|---|---|
| topic | `launchpad.chain.event`，只有这一条 |
| key | token 地址（小写）；`QuoteAssetConfigured` 用 asset 地址 |
| 顺序 | 同一 key 内严格按 `(blockNumber, logIndex)`；跨 key 不保证。**跨 key 没有依赖**：TokenLaunched 需要的配对资产参数已放进它自己的 `derived`，不依赖 `QuoteAssetConfigured` 先到 |
| 铸币 | 发币 tx 里 `Transfer(0x0 → curve)` 的 logIndex 早于 `TokenLaunched`，**不发这条 Transfer**；初始余额由 `TokenLaunched.derived.curveBalance` 给出。这样同一个币的第一条消息一定是 TokenLaunched |
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

| 字段 | 含义与说明 |
|---|---|
| `eventId` | 【必须】`v1:{chainId}:{blockHash}:{logIndex}:{removed}`，`v1` 是契约版本。审计表唯一键；至少一次投递靠它去重；重放按它定位 |
| `eventName` | 【必须】ABI 事件名。路由到 handler |
| `chainId` | 【必须】EVM chain id，十进制字符串。所有表的 `chain_id` 列 |
| `blockNumber` | 【必须】区块高度，十进制字符串。同币事件的顺序；按区块区间重放；余额乱序保护 |
| `blockHash` | 【必须】区块哈希，小写。`eventId` 的组成部分；审计 |
| `blockTimestamp` | 【必须，非 0】区块时间，秒，十进制字符串。成交时间、K 线分桶、发币时间排序、按区块时间取配对资产价格固化 USD。Java 没有查区块的兜底，缺了整条消息作废 |
| `logIndex` | 【必须】日志在区块中的序号。成交表唯一键 `(tx_hash, log_index)`；同 tx 内的顺序 |
| `txHash` | 【必须】交易哈希，小写。成交表唯一键；前端跳区块浏览器 |
| `txFrom` | 【必须】交易发起人，小写（Envio 要开 `transaction_fields: [from]`）。备查列，排查中继 / 路由问题时用 |
| `removed` | 【必须】恒 `false`。语义保留，Java 收到 `true` 只留审计不投影 |
| `payload.address` | 【必须】发出日志的合约地址，小写。Transfer 时它就是 token；其余作审计 |
| `payload.signature` | 【必须】规范签名，如 `CurveBuy(address,address,uint128,uint128,uint96,uint128)`。区分同名重载；审计 |
| `payload.args` | 【必须】ABI 具名参数原样，对象。链上事实 |
| `payload.derived` | 【按事件】Envio 解析的字段，对象。见各事件 |

## 十种事件

### QuoteAssetConfigured（QuoteAssetRegistry）

Java 写 `launchpad_quote_asset`（键 `config_hash`）。这是配对资产精度、毕业阈值的链上权威，Java 不再靠运营名单认精度。

| 字段 | 含义与说明 |
|---|---|
| `args.asset` | 【原始】【必须】配对资产地址，零地址 = 原生 ETH。按地址关联运营名单（代号、图标、价源） |
| `args.configHash` | 【原始】【必须】这份配置的哈希。`TokenLaunched.quoteConfigHash` 指向它；一份配置一行 |
| `args.decimals` | 【原始】【必须】配对资产精度。所有配对资产金额换整枚；USDG(6) 猜成 18 会差 10¹² |
| `args.graduationQuoteThreshold` | 【原始】【必须】毕业阈值，最小单位。进度条分母 |
| `args.initialVirtualQuoteReserve` | 【原始】【必须】曲线初始虚拟储备。核对 Envio 算出的价格；存档 |
| `args.enabled` | 【原始】【必须】当前是否允许新发币选它。运营名单缺价源时告警的对照 |
| `args.version` | 【原始】【可选】模板 / 校准算法版本。存档 |
| `args.targetNetGraduationQuote` | 【原始】【可选】目标净募集额。存档 |
| `args.sourcePriceTimestamp` | 【原始】【可选】校准用的价格时间。存档 |

### TokenLaunched（LaunchFactory）

Java 插入 `launchpad_token`，解析 `socials.storyFun` 绑叙事，反查发行者用户。

| 字段 | 含义与说明 |
|---|---|
| `args.token` | 【原始】【必须】发射币地址。币的主键；Kafka key |
| `args.curve` | 【原始】【必须】曲线合约地址。持有者榜标「Bonding Curve」行；审计对照 |
| `args.creator` | 【原始】【必须】发币人地址。反查平台用户；Launches 页签；OG；发行者持仓警示 |
| `args.quoteAsset` | 【原始】【必须】配对资产地址，零地址 = 原生 ETH。金额计价单位；取 USD 用哪个价；协议日按它分组 |
| `args.quoteConfigHash` | 【原始】【必须】指向 QuoteAssetConfigured。关联精度与阈值 |
| `args.launchConfigId` | 【原始】【必须】发射配置 id。存档 |
| `args.curveFeeBps` | 【原始】【必须】基础手续费 BPS，发币时快照。详情页展示 |
| `args.tickSpacing` | 【原始】【必须】毕业池的 tick spacing。存档 |
| `args.creatorTaxBps` | 【原始】【必须】创作者税 BPS，不可变。详情页展示；核对 derived 的费用拆分 |
| `args.creatorFeeRecipient` | 【原始】【必须】发币时的创作者费收款人。存档，不追更新 |
| `args.buybackEnabled` | 【原始】【必须】发币时的回购开关。存档，不追更新 |
| `args.name` | 【原始】【必须】币名。卡片、详情、搜索、OG 键 |
| `args.symbol` | 【原始】【必须】代号。同上 |
| `args.logo` | 【原始】【必须】币图 URI。卡片、详情 |
| `args.description` | 【原始】【必须】简介。详情 |
| `args.socials.storyFun` | 【原始】【必须】Story.Fun 发射页 URL。**叙事绑定的唯一依据**：解析 `/drama/{id}` 或 `/video/{id}` |
| `args.socials.website` | 【原始】【必须，可空串】官网。详情页展示 |
| `args.socials.twitter` | 【原始】【必须，可空串】详情页展示 |
| `args.socials.telegram` | 【原始】【必须，可空串】详情页展示 |
| `args.socials.discord` | 【原始】【必须，可空串】详情页展示 |
| `args.socials.farcaster` | 【原始】【必须，可空串】详情页展示 |
| `args.launchSalt` | 【原始】【可选】CREATE2 salt。存档 |
| `derived.quoteDecimals` | 【解析】【必须】配对资产精度，按 `quoteConfigHash` 查注册表得到。落币行，成交换算全靠它；Java 不查注册表 |
| `derived.graduationQuoteThreshold` | 【解析】【必须】毕业阈值。进度条分母 |
| `derived.initialVirtualQuoteReserve` | 【解析】【必须】初始虚拟储备。存档、核对 |
| `derived.totalSupply` | 【解析】【必须】总供应，合约常数 1e9 × 1e18。市值 = 价 × 它；持有占比分母；Java 不写合约常数 |
| `derived.tokenDecimals` | 【解析】【必须】发射币精度，合约常数 18。本币数量换整枚；Java 不写合约常数 |
| `derived.curveBalance` | 【解析】【必须】发币时铸给曲线的数量（= totalSupply）。替代不发的铸币 Transfer：Java 据此写曲线的余额行、`holder_count = 1` |
| `derived.quoteSymbol` | 【解析】【可选】配对资产代号，Envio 用 Effect 读一次 `symbol()`，原生币给 `ETH`。运营名单里没有这个资产时的展示兜底 |

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
"derived": { "quoteDecimals": "18", "quoteSymbol": "ETH", "initialVirtualQuoteReserve": "1000000000000000000",
             "graduationQuoteThreshold": "4000000000000000000",
             "totalSupply": "1000000000000000000000000000", "tokenDecimals": "18", "curveBalance": "1000000000000000000000000000" }
```

### CurveBuy（BondingCurve）

Java 写 `launchpad_trade`（CURVE / BUY）、持仓、K 线桶、协议日；币行 set 储备、价格、最近成交。

| 字段 | 含义与说明 |
|---|---|
| `args.buyer` | 【原始】【必须】调曲线的地址，经路由时是路由。成交行的对手方；排查 |
| `args.recipient` | 【原始】【必须】收币地址。名义交易者 |
| `args.grossQuoteIn` | 【原始】【必须】用户实付的配对资产，含全部费税、不含退款。**成交额**（`quote_amount`）、USD、24h 量 |
| `args.netQuoteIn` | 【原始】【必须】进入定价储备的部分。均价 `avg_price_quote`，持仓成本用 |
| `args.tokensOut` | 【原始】【必须】用户拿到的本币。成交数量；持仓数量 |
| `args.fee` | 【原始】【必须】费用总额。存档；核对拆分之和 |
| `derived.token` | 【解析】【必须】这条曲线对应的发射币。消息里只有 curve 地址；所有表按 token 关联 |
| `derived.trader` | 【解析】【必须】真实交易者。名义地址不是合约就是它；是合约按整笔收据穿透；穿透不出退回名义地址。Activity、持仓、持有者归属都按它，规则见[第 3 页](/envio) |
| `derived.baseFee` | 【解析】【必须】基础手续费，按合约 `_splitBuyFees` 从 `fee` 拆出。详情页费用展示 |
| `derived.creatorTax` | 【解析】【必须】创作者税。同上 |
| `derived.snipeTax` | 【解析】【必须，无则 `"0"`】反狙击税，来自同 tx 的 `SnipeTaxCharged`。同上 |
| `derived.quoteReserve` | 【解析】【必须】成交后曲线净募集（`trackedNetQuote`）。**毕业进度分子**（对外 `quoteRaised`）；流动性 |
| `derived.tokenReserve` | 【解析】【必须】成交后曲线库存（`trackedTokens`）。存档、核对 |
| `derived.priceQuote` | 【解析】【必须】成交后边际价，一枚本币值多少配对资产，十进制小数字符串。**币价**、K 线、市值 |

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

| 字段 | 含义与说明 |
|---|---|
| `args.seller` | 【原始】【必须】卖币地址。名义交易者 |
| `args.recipient` | 【原始】【必须】收款地址。对手方 |
| `args.tokensIn` | 【原始】【必须】卖出的本币。成交数量；持仓扣减 |
| `args.grossQuoteOut` | 【原始】【必须】离开定价储备的配对资产，扣费前。均价 |
| `args.netQuoteOut` | 【原始】【必须】用户实收。**成交额**、USD、盈亏 |
| `args.fee` | 【原始】【必须】费用总额。存档 |
| `derived.token` | 【解析】【必须】同 CurveBuy |
| `derived.trader` | 【解析】【必须】真实交易者，名义地址是 `seller`，是合约按整笔收据净流出最大的地址。同 CurveBuy |
| `derived.baseFee` | 【解析】【必须】基础手续费 = `fee − creatorTax`。费用展示 |
| `derived.creatorTax` | 【解析】【必须】创作者税 = `grossQuoteOut × creatorTaxBps ÷ 10000` 向下取整。费用展示 |
| `derived.quoteReserve` | 【解析】【必须】同 CurveBuy |
| `derived.tokenReserve` | 【解析】【必须】同 CurveBuy |
| `derived.priceQuote` | 【解析】【必须】同 CurveBuy |

### LaunchSwept（LaunchFactory）

Java 写币行 `curve_closed_at` / `swept_quote` / `swept_token`，`status = GRADUATED`。

| 字段 | 含义与说明 |
|---|---|
| `args.token` | 【原始】【必须】发射币。定位币行；同 tx 的 `CurveCompleted` 没有它，所以订这条 |
| `args.quoteAmount` | 【原始】【必须】交给毕业流程的配对资产。详情页「毕业时募集」 |
| `args.tokenAmount` | 【原始】【必须】交给毕业流程的本币。存档 |

### V4PoolGraduated（V4GraduationReceiver）

Java 写币行 `pool_created_at` / `pool_id` / `pool_position_id` / `pool_liquidity` / `price_quote`。

| 字段 | 含义与说明 |
|---|---|
| `args.token` | 【原始】【必须】发射币。定位币行 |
| `args.curve` | 【原始】【可选】曲线地址。存档 |
| `args.poolId` | 【原始】【必须】Uniswap v4 poolId。前端拼 Uniswap 链接；与 Swap 对照 |
| `args.positionId` | 【原始】【必须】锁定的 LP NFT id。存档、前端链接 |
| `args.sqrtPriceX96` | 【原始】【可选】池初始价原值。存档 |
| `args.liquidity` | 【原始】【必须】初始流动性。`liquidity_usd`（若做） |
| `args.quoteAmount` | 【原始】【必须】迁入池的配对资产。存档 |
| `args.tokenAmount` | 【原始】【必须】迁入池的本币。存档 |
| `args.tokenDust` | 【原始】【可选】本币尾数。存档 |
| `args.quoteDust` | 【原始】【可选】配对资产尾数。存档 |
| `derived.priceQuote` | 【解析】【必须】池初始价，一枚本币值多少配对资产，由 `sqrtPriceX96` 按 currency0 / 1 方向与两侧精度换算。建池到第一笔 Swap 之间的币价 |
| `derived.poolQuoteReserve` `derived.poolTokenReserve` | 【解析】【待定，Q3】池初始两侧储备。同 Swap |

### PoolRegistered（GraduatedPoolHook）

Java 写币行 `pool_id` / `pool_quote_asset`（与 V4PoolGraduated 谁先到谁写）。

| 字段 | 含义与说明 |
|---|---|
| `args.poolId` | 【原始】【必须】Uniswap v4 poolId。与 V4PoolGraduated 互为兜底 |
| `args.token` | 【原始】【必须】发射币。定位币行 |
| `args.quoteAsset` | 【原始】【必须】池的计价资产。核对 = 发币时的 quoteAsset |

### LaunchGraduationRescued（LaunchFactory）

Java 写币行 `rescued_at`，`status = RESCUED`。

| 字段 | 含义与说明 |
|---|---|
| `args.token` | 【原始】【必须】发射币。定位币行 |
| `args.recipient` | 【原始】【必须】储备释放给谁。存档 |
| `args.quoteAmount` | 【原始】【必须】释放的配对资产。存档 |
| `args.tokenAmount` | 【原始】【必须】释放的本币。存档；展示口径待产品定 |

### Swap（PoolManager，只发我们的池）

Java 写 `launchpad_trade`（POOL）、持仓、K 线桶、协议日；币行 set 价格、流动性、最近成交。

| 字段 | 含义与说明 |
|---|---|
| `args.id` | 【原始】【必须】poolId。存档；与币行 `pool_id` 对照 |
| `args.sender` | 【原始】【必须】调 PoolManager 的地址，通常是路由。对手方；排查 |
| `args.amount0` | 【原始】【必须】currency0 的 delta，swapper 视角，负 = 付出。存档、核对 derived |
| `args.amount1` | 【原始】【必须】currency1 的 delta。同上 |
| `args.sqrtPriceX96` | 【原始】【必须】成交后池价原值。存档、核对 |
| `args.liquidity` | 【原始】【必须】成交后池流动性。`liquidity_usd`（若做） |
| `args.tick` | 【原始】【可选】存档 |
| `args.fee` | 【原始】【可选】池费率。存档 |
| `derived.token` | 【解析】【必须】这个池对应的发射币。消息里只有 poolId |
| `derived.side` | 【解析】【必须】`BUY` / `SELL`。本币是 currency0 还是 currency1 要按地址大小判，Java 不做 |
| `derived.trader` | 【解析】【必须，可为 null】真实交易者，按整笔收据里本币 Transfer 净流量：买取净流入最大、卖取净流出最大。Activity、持仓；null 的成交照记但不进 Activity |
| `derived.tokenAmount` | 【解析】【必须】本币数量，绝对值，最小单位。成交数量 |
| `derived.quoteAmount` | 【解析】【必须】配对资产数量，绝对值，最小单位。成交额、USD |
| `derived.priceQuote` | 【解析】【必须】成交后池价，一枚本币值多少配对资产。**毕业后的币价**、K 线、市值 |
| `derived.hookFee` | 【解析】【必须，无则 `"0"`】同 tx `HookFeeCollected.fee`。费用展示 |
| `derived.creatorTax` | 【解析】【必须，无则 `"0"`】同 tx `HookFeeCollected.creatorTax`。费用展示 |
| `derived.feeCurrency` | 【解析】【必须】费用按哪个币收，可能是本币也可能是配对资产。费用展示时换算 |
| `derived.poolQuoteReserve` `derived.poolTokenReserve` | 【解析】【待定，Q3】成交后池两侧的储备。只在 `liquidity_usd` 要做时才要；Java 只乘价，不做 Uniswap 数学 |

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

| 字段 | 含义与说明 |
|---|---|
| `args.from` | 【原始】【必须】转出方，零地址 = 铸造。审计 |
| `args.to` | 【原始】【必须】转入方，零地址 = 销毁。审计 |
| `args.value` | 【原始】【必须】数量，最小单位。审计 |
| `derived.fromBalance` | 【解析】【必须，from 为零地址时 null】转出方**这笔之后**的余额。直接 set 余额表；Java 不做加减 |
| `derived.toBalance` | 【解析】【必须，to 为零地址时 null】转入方**这笔之后**的余额。同上 |
| `derived.totalSupply` | 【解析】【必须】这笔之后的总供应。销毁后市值分母跟着减 |
| `derived.positiveBalanceCount` | 【解析】【必须】这笔之后余额 > 0 的地址数，含合约。持有人数，读时按 kind 剔协议合约 |
| `derived.fromKind` | 【解析】【必须】转出方是什么：`USER` / `CURVE` / `POOL_MANAGER` / `FACTORY` / `RECEIVER` / `LOCKER` / `ROUTER` / `VAULT` / `ZERO`。协议合约的地址表只在 Envio 的 config 里；Java 存进余额行，持有者榜标「Bonding Curve」、剔除协议合约、资产页只列 USER 都靠它 |
| `derived.toKind` | 【解析】【必须】转入方是什么，取值同上 |

```json
"payload": {
  "address": "0x3d7e…4cdd",
  "signature": "Transfer(address,address,uint256)",
  "args": { "from": "0x73d4…31eb", "to": "0x2bf5…7675", "value": "714285714285714285714285715" },
  "derived": { "fromBalance": "285714285714285714285714285", "toBalance": "714285714285714285714285715",
               "fromKind": "CURVE", "toKind": "USER",
               "totalSupply": "1000000000000000000000000000", "positiveBalanceCount": "2" }
}
```

一笔曲线买入至少带出一条 Transfer（curve → 用户），经路由时两条；这是消息量的大头。铸币那条不发（见「topic 与投递」）。

### Heartbeat（不是合约事件，Envio 每分钟发一条）

`eventName = "Heartbeat"`，`payload.args` 为空，`payload.derived` 如下；`eventId = v1:{chainId}:heartbeat:{processedBlock}`。不落审计表，Java 只更新内存里的「Envio 最近处理到哪」。

| 字段 | 含义与说明 |
|---|---|
| `derived.headBlock` | 【解析】【必须】Envio 看到的链头区块号。与下一项的差 = Envio 落后多少，超阈值告警 |
| `derived.processedBlock` | 【解析】【必须】Envio 已处理完的区块号。Java 消费者 lag 告警的基准；资产页余额的 `syncedAt` 取它对应的区块时间 |
| `derived.processedBlockTime` | 【解析】【必须】已处理区块的时间，秒。同上 |

没有它 Java 分不清「市场安静」和「Envio 停了」。

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
- Java 的 `ChainEventParser` 只校验信封；`args` / `derived` 由各 handler 用 `requireArg` 取，本页标【必须】的缺了进 FAILED
