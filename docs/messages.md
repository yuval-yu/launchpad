---
title: 4 · 消息契约：我们要什么字段、为什么要
---

# 消息契约：我们要什么字段、为什么要

这一页是给写 Envio 的同事的需求清单。一条消息 = 一条已解码的合约事件日志 + Envio 解析好的几个字段。每个事件一张表，三列：字段、含义与说明、**扫链现状**。

说明列统一用三个标记：

- **【原始】** ABI 参数原样透传；**【解析】** Envio 看了内部状态或整笔交易之后算出来的，Java 拿不到、也不该自己算
- **【必须】** 缺了 Java 进 FAILED；**【可选】** 只存档，缺了不影响
- 后面一句是我们拿它做什么

扫链现状列对照的是扫链同学的消息定义（`envio/docs/*.md`，最新提交 `f8ba507`，09-21；另对照了 dev Kafka 09-21 整个 topic 的实抓 371 条）：**已有** = 他们的文档里有这个字段；**缺** = 没有，需要补。整个事件都没有的，在标题里标「扫链未提供」。

## 一眼看清：哪些字段必须由 Envio 解析

| 解析字段 | 出现在 | Java 为什么不能自己来 |
|---|---|---|
| `trader` | Swap（必须）· CurveBuy · CurveSell（可选） | 池内 Swap 的 `sender` 是路由，事件里没有用户地址，只有看整笔交易里本币 Transfer 的净流量才能定；曲线事件缺省取 `recipient` / `seller`，只有名义地址是合约（0x Settler 这类）时才需要 Envio 穿透 |
| `curve.realQuoteReserve` `curve.virtualQuoteReserve` `curve.virtualTokenReserve` | CurveBuy · CurveSell | 事件里只有这笔的金额，成交后的状态不在事件里；储备是 Envio 按事件累加的绝对值，比 Java 自己累加健壮（漏一条消息不会永远错下去）。**边际价扫链不给，Java 用两个定价储备相除（用户 09-20 定）**——只是对消息里两个现成的数做一次除法，不碰 ABI、不查链 |
| `curve.graduationQuoteThreshold` `curve.initialVirtualQuoteReserve` | TokenLaunched | 扫链在发币那个区块 `eth_call` 读曲线合约得到（原设想是按 `quoteConfigHash` 查注册表，取法归扫链定）。这两个是**按币的快照**：治理重配某个配对资产后，新币用新参数、老币保留发币时的值，所以不能从运营名单或注册表现值取。配对资产的精度、代号、图标由运营在 admin Redis 里维护，不走消息 |
| `priceQuote` | LaunchGraduated · Swap | `sqrtPriceX96` 换算与 currency0 / 1 方向是 Uniswap 数学 |
| `side` `tokenAmount` `quoteAmount` | Swap | `amount0` / `amount1` 哪个是本币要按地址大小判 |
| `liquidityQuote` | LaunchGraduated · Swap | 毕业后池的流动性，以配对资产计 = 池两侧按池价折成配对资产之和；v4 不存余额，要从 L 与 √P 推，是 Uniswap 数学。曲线阶段不需要：Java 用 `quoteReserve × 2` |
| ~~`fromBalance` `toBalance` `totalSupply` `positiveBalanceCount`~~ | Transfer | **09-21 起不需要**：余额、总供应、持有人数由 Java 从转账事实行累加（见下文 Transfer 一节） |
| `fromKind` `toKind` | Transfer | 哪些地址是曲线 / PoolManager / 工厂 / Receiver / Locker / 路由，只有 Envio 的 config 里有这份地址表；Java 靠它给持有者榜标「Bonding Curve」、剔除协议合约 |

## topic 与投递

| 项 | 值 | 扫链现状 |
|---|---|---|
| topic | `launchpad.chain.events`，只有这一条 | 已有 |
| key | **所有事件同一种键**，取 token 地址（小写）。同一个币的发币、成交、Transfer、Swap 必须落在同一个分区 | 已有（`cbcf16e` 起全部按 token） |
| 顺序 | 同一 key 内严格按 `(blockNumber, logIndex)`；跨 key 不保证 | 已有 |
| 铸币 | 发币 tx 里 `Transfer(0x0 → curve)` 的 logIndex 早于 `TokenLaunched`，**不发这条 Transfer**；Java 收到 TokenLaunched 时按合约常量 `TOTAL_SUPPLY` 写曲线的余额行。这样同一个币的第一条消息一定是 TokenLaunched | 已有：铸币那笔不发，扫链在 TokenLaunched 里自己初始化曲线余额 |
| 投递 | 至少一次；Java 按 `eventId` 去重 | 已有 |
| 确认 | 区块落后链头 ≥ N 块才发；`removed` 恒为 `false` | 未定（他们的 `removed` 语义是「可能为 true」，见[第 10 页](/rollout) Q3） |
| 编码 | JSON，UTF-8；`args` / `derived` 里的 uint / int 一律**十进制字符串**；信封的 `blockNumber` `blockTimestamp` `chainId` `logIndex` 可以是 JSON number（安全整数范围内，Java 两种都收）；地址、哈希、bytes32 一律 **`0x` 小写**；bool 用 JSON 布尔；string 原样；struct 展开成对象 | 已有 |
| 事件名 | ABI 名，不起别名；`args` 字段名 = ABI 参数名 | 已有 |

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
    "token": { "token": "0xb0f0…d42e" },
    "curve": { "…": "曲线的状态：发币 = 两个按币快照的参数，买 / 卖 = 成交后的储备" },
    "derived": { "…": "这一条事件算出来的其余字段，各事件不同" }
  }
}
```

| 字段 | 含义与说明 | 扫链现状 |
|---|---|---|
| `eventId` | 【必须】`v1:{chainId}:{blockHash}:{logIndex}:{removed}`，`v1` 是契约版本。审计表唯一键；至少一次投递靠它去重；重放按它定位 | 已有 |
| `eventName` | 【必须】ABI 事件名。路由到 handler | 已有 |
| `chainId` | 【必须】EVM chain id。所有表的 `chain_id` 列。**与 Java 配置的链不符 → 整条进死信，不落审计表**（防环境混线） | 已有 |
| `blockNumber` | 【必须】区块高度。同币事件的顺序；按区块区间重放；余额乱序保护 | 已有 |
| `blockHash` | 【必须】区块哈希，小写。`eventId` 的组成部分；审计 | 已有 |
| `blockTimestamp` | 【必须，非 0】区块时间，秒。成交时间、K 线分桶、发币时间排序、按区块时间取配对资产价格固化 USD。Java 没有查区块的兜底，缺了整条消息作废 | 已有 |
| `logIndex` | 【必须】日志在区块中的序号。成交表唯一键 `(tx_hash, log_index)`；同 tx 内的顺序 | 已有 |
| `txHash` | 【必须】交易哈希，小写。成交表唯一键；前端跳区块浏览器 | 已有 |
| `txFrom` | 【必须】交易发起人，小写（Envio 要开 `transaction_fields: [from]`）。备查列，排查中继 / 路由问题时用 | **缺** |
| `removed` | 【必须】恒 `false`。语义保留，Java 收到 `true` 只留审计不投影 | 已有（语义待定，见上表「确认」） |
| `payload.address` | 【必须，Heartbeat 除外】发出日志的合约地址，小写。Transfer 时它就是 token；其余作审计 | 已有 |
| `payload.signature` | 【可选】规范签名。审计用；没有同名重载，不靠它路由 | 缺（可选，不催） |
| `payload.args` | 【必须】ABI 具名参数原样，对象。链上事实 | 已有 |
| `payload.token` | 【按事件】从 Envio 的 Token 实体拷出的、与这个币有关的字段，对象。至少有 `token.token`（发射币地址）。币级字段（配对资产精度、阈值、初始储备）也可以放这里 | 已有（曲线事件；TokenLaunched 没带，它的 `args.token` 本来就是） |
| `payload.curve` | 【曲线事件】从 Envio 的 Curve 实体拷出的曲线状态，对象，**字段名以扫链为准**（用户 09-20 定）。发币：`graduationQuoteThreshold` / `initialVirtualQuoteReserve`；买 / 卖：成交后的 `realQuoteReserve` / `virtualQuoteReserve` / `virtualTokenReserve`（另有两个我们不读的）。见各事件 | 已有（`de9ac1b`） |
| `payload.derived` | 【按事件】这一条事件算出来的其余字段，对象：trader、池内成交的方向 / 数量 / 价 / 流动性、Transfer 后的余额。曲线阶段只剩可选的 `trader`。见各事件 | **缺**（所有事件都没有） |

## 九种事件

### TokenLaunched（LaunchFactory）· 扫链已提供，字段齐

Java 插入 `launchpad_v2_token`，解析 `socials.storyFun` 绑叙事，反查发行者用户。总供应（10 亿枚；库里的数量一律存整枚，见[第 7 页](/tables)）、精度（18）、铸给曲线的初始余额（= 总供应）是合约 `LaunchDefaults` 里编译死的全局常量，**不随消息来，Java 放 `LaunchConstants`**（用户 09-18 定）；合约升级改常量时随事件签名一起改。配对资产的精度、代号、图标由运营配置（admin Redis 的 `quoteTokens` 名单）按地址补，不走消息（用户 09-19 定）；**配对资产的精度是必需品**（用户 09-20 定）：消息里的数量都是最小单位，Java 入库前按精度换成整枚，没有精度就换不出任何一个数 —— 名单里没有这个配对资产时这条发币消息直接失败（审计行 FAILED），运营补进名单后自动重投就过；运营保证配对资产先配进名单。

| 字段 | 含义与说明 | 扫链现状 |
|---|---|---|
| `args.token` | 【原始】【必须】发射币地址。币的主键；Kafka key | 已有 |
| `args.curve` | 【原始】【必须】曲线合约地址。持有者榜标「Bonding Curve」行；审计对照 | 已有 |
| `args.creator` | 【原始】【必须】发币人地址。反查平台用户；Launches 页签；OG；发行者持仓警示 | 已有 |
| `args.quoteAsset` | 【原始】【必须】配对资产地址，零地址 = 原生 ETH。金额计价单位；取 USD 用哪个价；协议日按它分组 | 已有 |
| `args.quoteConfigHash` | 【原始】【可选】链上配对资产配置的哈希。存档 | 已有 |
| `args.launchConfigId` | 【原始】【必须】发射配置 id。存档 | 已有 |
| `args.curveFeeBps` | 【原始】【必须】基础手续费 BPS，发币时快照。详情页展示 | 已有 |
| `args.tickSpacing` | 【原始】【必须】毕业池的 tick spacing。存档 | 已有 |
| `args.creatorTaxBps` | 【原始】【必须】创作者税 BPS，不可变。详情页展示 | 已有 |
| `args.creatorFeeRecipient` | 【原始】【必须】发币时的创作者费收款人。存档，不追更新 | 已有 |
| `args.buybackEnabled` | 【原始】【必须】发币时的回购开关。存档，不追更新 | 已有 |
| `args.name` | 【原始】【必须】币名。卡片、详情、搜索、OG 键 | 已有 |
| `args.symbol` | 【原始】【必须】代号。同上 | 已有 |
| `args.logo` | 【原始】【必须】币图 URI。卡片、详情 | 已有 |
| `args.description` | 【原始】【必须】简介。详情 | 已有 |
| `args.socials.storyFun` | 【原始】【必须，可空串】**叙事绑定的唯一依据**，由前端发币时写入（09-19 定，已与前端对齐）：短剧 `drama_{dramaId}`、短视频 `video_{videoId}`，空串 = 没有绑定剧集。不是 URL | 已有 |
| `args.socials.website` | 【原始】【必须，可空串】官网。原样存库、详情页原样展示，**不做任何解析，不参与叙事绑定** | 已有 |
| `args.socials.twitter` | 【原始】【必须，可空串】详情页展示 | 已有 |
| `args.socials.telegram` | 【原始】【必须，可空串】详情页展示 | 已有 |
| `args.socials.discord` | 【原始】【必须，可空串】详情页展示 | 已有 |
| `args.socials.farcaster` | 【原始】【必须，可空串】详情页展示 | 已有 |
| `args.launchSalt` | 【原始】【可选】CREATE2 salt。存档 | 已有 |
| `curve.graduationQuoteThreshold` | 【解析】【必须】毕业阈值。进度条分母。扫链放在 `payload.curve`（09-20 起字段以扫链为准） | 已有 |
| `curve.initialVirtualQuoteReserve` | 【解析】【必须】初始虚拟储备。存档、核对 | 已有 |

```json
"args": {
  "token": "0x3d7e…4cdd", "curve": "0x73d4…31eb", "creator": "0x2bf5…7675",
  "launchSalt": "0x…", "quoteAsset": "0x0000000000000000000000000000000000000000",
  "quoteConfigHash": "0xab…", "launchConfigId": "1", "curveFeeBps": "100", "tickSpacing": "60",
  "creatorFeeRecipient": "0x2bf5…7675", "creatorTaxBps": "50", "buybackEnabled": false,
  "name": "Loxley", "symbol": "LOX", "logo": "https://…/lox.png", "description": "…",
  "socials": { "website": "", "twitter": "", "telegram": "", "discord": "", "farcaster": "",
               "storyFun": "drama_1024" }
},
"curve": { "initialVirtualQuoteReserve": "1000000000000000000",
           "graduationQuoteThreshold": "4000000000000000000" }
```

### CurveBuy（BondingCurve）· 扫链已提供，字段齐

Java 写 `launchpad_v2_trade`（CURVE / BUY）、持仓、K 线桶、协议日；币行 set 净募集、价格、最近成交，流动性 = 净募集 × 2。

| 字段 | 含义与说明 | 扫链现状 |
|---|---|---|
| `args.buyer` | 【原始】【必须】调曲线的地址，经路由时是路由。成交行的对手方；排查 | 已有 |
| `args.recipient` | 【原始】【必须】收币地址。名义交易者 | 已有 |
| `args.grossQuoteIn` | 【原始】【必须】用户实付的配对资产，含全部费税、不含退款。**成交额**（`quote_amount`）、USD、24h 量 | 已有 |
| `args.netQuoteIn` | 【原始】【必须】进入定价储备的部分。均价 `avg_price_quote`，持仓成本用 | 已有 |
| `args.tokensOut` | 【原始】【必须】用户拿到的本币。成交数量；持仓数量 | 已有 |
| `args.fee` | 【原始】【必须】这笔扣的手续费总额（基础费 + 创作者税 + 反狙击税）。存档，本期不拆分不展示 | 已有 |
| `token.token` | 【解析】【必须】这条曲线对应的发射币。Java 只认它，不按 curve 反查 | 已有 |
| `derived.trader` | 【解析】【可选】真实交易者。**没给时 Java 取 `recipient`**——用户直接调曲线、经 TradeRouter 买，收币的都是用户本人。只有 `recipient` 是合约（0x Settler 这类聚合器自己收币再转给用户）时才需要 Envio 按整笔收据穿透后给出，规则见[第 3 页](/envio)。Activity、持仓、持有者归属都按它 | 缺（可选） |
| `curve.realQuoteReserve` | 【解析】【必须】成交后曲线里的净募集（= 合约 `trackedNetQuote`；Envio 按事件累加：买 `+= netQuoteIn`，卖 `-= grossQuoteOut`）。**毕业进度分子**（对外 `quoteRaised`）；曲线阶段的流动性 = 它 × 2 | 已有 |
| `curve.virtualQuoteReserve` · `curve.virtualTokenReserve` | 【解析】【必须】成交后的两个定价储备，与合约 `getPricingReserves()` 一致。**扫链不给现成的价，由 Java 算（用户 09-20 定）**：`priceQuote = virtualQuoteReserve ÷ virtualTokenReserve`，两个储备先各自按精度换成整枚再相除（等价于最小单位之比 `× 10^(18 − 配对资产精度)`，逐位相同），30 位小数 HALF_UP。**币价**、K 线、市值 | 已有 |
| `curve.realTokenReserve` · `curve.remainingSellableTokens` | 【解析】【不读】扫链多给的，我们没有读者 | 已有 |

```json
"payload": {
  "address": "0x73d4…31eb",
  "signature": "CurveBuy(address,address,uint128,uint128,uint96,uint128)",
  "args": { "buyer": "0x096a…4fd4", "recipient": "0x2bf5…7675",
            "grossQuoteIn": "100000000000000", "netQuoteIn": "99000000000000",
            "tokensOut": "714285714285714285714285715", "fee": "1000000000000" },
  "token": { "token": "0x3d7e…4cdd" },
  "curve": { "realQuoteReserve": "99000000000000", "realTokenReserve": "…",
             "remainingSellableTokens": "…",
             "virtualQuoteReserve": "1000099000000000000", "virtualTokenReserve": "…" },
  "derived": { "trader": "0x2bf5…7675" }
}
```

### CurveSell（BondingCurve）· 扫链已提供，字段齐

Java 写 `launchpad_v2_trade`（CURVE / SELL），持仓结一笔已实现盈亏，其余同买入。

| 字段 | 含义与说明 | 扫链现状 |
|---|---|---|
| `args.seller` | 【原始】【必须】卖币地址。名义交易者 | 已有 |
| `args.recipient` | 【原始】【必须】收款地址。对手方 | 已有 |
| `args.tokensIn` | 【原始】【必须】卖出的本币。成交数量；持仓扣减 | 已有 |
| `args.grossQuoteOut` | 【原始】【必须】离开定价储备的配对资产，扣费前。均价 | 已有 |
| `args.netQuoteOut` | 【原始】【必须】用户实收。**成交额**、USD、盈亏 | 已有 |
| `args.fee` | 【原始】【必须】这笔扣的手续费总额。存档，本期不拆分不展示 | 已有 |
| `token.token` | 【解析】【必须】同 CurveBuy | 已有 |
| `derived.trader` | 【解析】【可选】真实交易者。**没给时 Java 取 `seller`**；只有 `seller` 是合约时才需要 Envio 按整笔收据净流出最大的地址给出 | 缺（可选） |
| `curve.realQuoteReserve` | 【解析】【必须】同 CurveBuy | 已有 |
| `curve.virtualQuoteReserve` · `curve.virtualTokenReserve` | 【解析】【必须】同 CurveBuy | 已有 |

### CurveCompleted（BondingCurve）· 扫链已提供，字段齐

曲线关闭 = 产品口径的「已毕业」。Java 写币行 `curve_closed_at` / `swept_quote` / `swept_token`，`status = GRADUATED`。同 tx 的工厂事件 `LaunchSwept` 与它等价，扫链给的是这一条，直接用。

| 字段 | 含义与说明 | 扫链现状 |
|---|---|---|
| `args.recipient` | 【原始】【可选】储备交给谁（工厂）。存档 | 已有 |
| `args.quoteAmount` | 【原始】【必须】交给毕业流程的配对资产。详情页「毕业时募集」 | 已有 |
| `args.tokenAmount` | 【原始】【必须】交给毕业流程的本币。存档 | 已有 |
| `token.token` | 【解析】【必须】这条曲线对应的发射币。定位币行 | 已有 |

### LaunchGraduated（LaunchFactory）· 扫链已提供，字段齐

**09-21 改：原设计认的是 `V4GraduationReceiver.V4PoolGraduated`，扫链订阅的是同一笔交易里 LaunchFactory 发的这一个并补了 `derived`，我们这边改名，扫链零改动。**
Java 写币行 `pool_created_at`（区块时间）/ `pool_id`（一次性，「还没写过才写」）与 `price_quote` / `liquidity_quote`（走成交状态水位线）。不存池的其它信息，不碰 `status`。
同一笔交易里的日志顺序是 PoolRegistered → Initialize → ModifyLiquidity → LaunchGraduated（dev 实抓核实），所以 `derived` 是建池后的真实值。

| 字段 | 含义与说明 | 扫链现状 |
|---|---|---|
| `args.token` | 【原始】【必须】发射币。定位币行（这个事件没有 `payload.token` 容器） | 已有 |
| `args.curve` `args.receiver` `args.quoteAsset` | 【原始】【可选】曲线、毕业接收合约、配对资产。存档 | 已有 |
| `args.quoteAmount` `args.tokenAmount` | 【原始】【可选】迁入池的两侧数量。存档 | 已有 |
| `derived.poolId` | 【解析】【必须】官方池的 Uniswap v4 poolId（PoolRegistered 写进扫链 Token 实体的那个）。前端拼 Uniswap 链接；与 Swap 对照 | 已有 |
| `derived.priceQuote` | 【解析】【必须】池初始价，一枚本币值多少配对资产，30 位小数。建池到第一笔 Swap 之间的币价 | 已有 |
| `derived.liquidityQuote` | 【解析】【必须】建池后池的流动性，以配对资产**最小单位**计、向下取整。建池到第一笔 Swap 之间的 `liquidity_usd` | 已有 |

```json
"payload": {
  "address": "0xb872…ed9e",
  "args": { "token": "0xb4ec…1a2c", "curve": "0x1fb0…5d19", "receiver": "0x6bb7…1770", "quoteAsset": "0x7e95…802f",
            "quoteAmount": "8090000003", "tokenAmount": "239256050000000000000000000" },
  "derived": { "poolId": "0x15ce…4db4", "priceQuote": "0.000033813147057305342957889675", "liquidityQuote": "16180000005" }
}
```

### PoolRegistered（GraduatedPoolHook）· 扫链已提供，字段齐

Java 写币行 `pool_id`（与 LaunchGraduated 谁先到谁写）。

| 字段 | 含义与说明 | 扫链现状 |
|---|---|---|
| `args.poolId` | 【原始】【必须】Uniswap v4 poolId。与 LaunchGraduated 互为兜底 | 已有 |
| `args.token` | 【原始】【必须】发射币。定位币行 | 已有 |
| `args.quoteAsset` | 【原始】【可选】池的计价资产。存档 | 已有 |

### LaunchGraduationRescued（LaunchFactory）· 扫链已提供（dev 上还没发生过，没有实抓样例）

Java 写币行 `rescued_at`，`status = RESCUED`。

| 字段 | 含义与说明 | 扫链现状 |
|---|---|---|
| `args.token` | 【原始】【必须】发射币。定位币行 | 已有 |
| `args.recipient` | 【原始】【必须】储备释放给谁。存档 | 已有 |
| `args.quoteAmount` | 【原始】【必须】释放的配对资产。存档 | 已有 |
| `args.tokenAmount` | 【原始】【必须】释放的本币。存档；展示口径待产品定 | 已有 |

### Swap（PoolManager，只发我们的池）· 扫链已提供，字段齐

Java 写 `launchpad_v2_trade`（POOL）、持仓、K 线桶、协议日；币行 set 价格、流动性、最近成交。扫链 `f8ba507` 已发，只发官方池（`poolId` 匹配），`trader` 用收据里发射币 Transfer 的净流量认、认不出为 `null`。

| 字段 | 含义与说明 | 扫链现状 |
|---|---|---|
| `args.id` | 【原始】【必须】poolId。存档；与币行 `pool_id` 对照 | 已有 |
| `args.sender` | 【原始】【必须】调 PoolManager 的地址，通常是路由。对手方；排查 | 已有 |
| `args.amount0` | 【原始】【必须】currency0 的 delta，swapper 视角，负 = 付出。存档、核对 derived | 已有 |
| `args.amount1` | 【原始】【必须】currency1 的 delta。同上 | 已有 |
| `args.sqrtPriceX96` | 【原始】【必须】成交后池价原值。存档、核对 | 已有 |
| `args.liquidity` | 【原始】【可选】成交后池流动性原值。存档 | 已有 |
| `args.tick` | 【原始】【可选】存档 | 已有 |
| `args.fee` | 【原始】【可选】池费率原值。存档 | 已有 |
| `token.token` | 【解析】【必须】这个池对应的发射币，与曲线事件同样放在 `payload.token`。Java 只认它，不按 poolId 反查 | 已有 |
| `derived.side` | 【解析】【必须】`BUY` / `SELL`。本币是 currency0 还是 currency1 要按地址大小判，Java 不做 | 已有 |
| `derived.trader` | 【解析】【必须，可为 null】真实交易者，按整笔收据里本币 Transfer 净流量：买取净流入最大、卖取净流出最大。Activity、持仓；null 的成交照记但不进 Activity | 已有 |
| `derived.tokenAmount` | 【解析】【必须】本币数量，绝对值，最小单位。成交数量 | 已有 |
| `derived.quoteAmount` | 【解析】【必须】配对资产数量，绝对值，最小单位。成交额、USD | 已有 |
| `derived.priceQuote` | 【解析】【必须】成交后池价，一枚本币值多少配对资产。**毕业后的币价**、K 线、市值 | 已有 |
| `derived.liquidityQuote` | 【解析】【必须】成交后池的流动性，以配对资产计：两侧按池价折成配对资产之和。`liquidity_usd = liquidityQuote × 配对资产价` | 已有 |

```json
"payload": {
  "address": "0xpoolmanager…",
  "signature": "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
  "args": { "id": "0x1dcf…a049", "sender": "0xrouter…", "amount0": "-2500000000000000",
            "amount1": "18000000000000000000000", "sqrtPriceX96": "…", "liquidity": "…", "tick": "-201234", "fee": "3000" },
  "token": { "token": "0x3d7e…4cdd" },
  "derived": { "side": "BUY", "trader": "0x944…",
               "tokenAmount": "18000000000000000000000", "quoteAmount": "2500000000000000",
               "priceQuote": "0.000000000000138", "liquidityQuote": "9000000000000000000" }
}
```

### Transfer（LaunchToken，只发发射币，不分池）· 扫链已提供

**09-21 改：余额由 Java 累加，扫链不再需要给变动后的绝对值。** 每条 Transfer 先落转账事实行 `launchpad_v2_transfer`（唯一键 `(tx_hash, log_index)`），
**只有首插成功**才给 `launchpad_v2_balance` 转出方 / 转入方两行原子加减，并推进币行的 `total_supply`（销毁）与 `holder_count`（只数用户地址，用户余额跨过 0 才变）——
与成交同一套「事实行首插才推进派生表」的纪律，所以重复投递与回放不多算；加减可交换，所以乱序与补发不影响最终值。
**代价是没有自愈**：漏发一条，那两个地址的余额一直错到补发为止，所以每个币的 Transfer 必须从发币那个区块起一条不漏（补发安全，事实表去重）。
野池成交、钱包互转天然覆盖：它们只表现为 Transfer。

| 字段 | 含义与说明 | 扫链现状 |
|---|---|---|
| `args.from` | 【原始】【必须】转出方，零地址 = 铸造（总供应加）。余额减 | 已有 |
| `args.to` | 【原始】【必须】转入方，零地址 = 销毁（总供应减）。余额加 | 已有 |
| `args.value` | 【原始】【必须】数量，最小单位。Java 按 18 位换整枚后加减 | 已有 |
| `token.token` | 【解析】【必须】= `payload.address`。定位币行 | 已有 |
| `derived.fromKind` | 【解析】【必须】转出方是什么：`USER` / `CURVE` / `POOL_MANAGER` / `FACTORY` / `RECEIVER` / `LOCKER` / `ROUTER` / `VAULT` / `ZERO`。协议合约的地址表只在 Envio 的 config 里（Hook 归在 `RECEIVER`）；Java 在**建余额行时**存进去，持有者榜标「Bonding Curve」、剔除协议合约、资产页只列 USER、持有人数只数 USER 都靠它。**缺了这条消息 FAILED**，不悄悄当成 USER | 已有 |
| `derived.toKind` | 【解析】【必须】转入方是什么，取值同上 | 已有 |
| ~~`derived.fromBalance` `toBalance` `totalSupply` `positiveBalanceCount`~~ | 09-21 起不需要。扫链现在还带着，**Java 不读**（读了就是两个真相来源）；它们是现成的对账基准 —— 集成测试拿 dev 实抓 181 条 Transfer 验过，Java 累加的结果与它们逐个相等 | 在发，可删 |

```json
"payload": {
  "address": "0x3d7e…4cdd",
  "args": { "from": "0x73d4…31eb", "to": "0x2bf5…7675", "value": "714285714285714285714285715" },
  "token": { "token": "0x3d7e…4cdd" },
  "derived": { "fromKind": "CURVE", "toKind": "USER" }
}
```

一笔曲线买入至少带出一条 Transfer（curve → 用户），经路由时两条；这是消息量的大头。铸币那条不发（见「topic 与投递」），曲线的初始余额由发币 handler 按常量写。

### Heartbeat（不是合约事件，Envio 每分钟发一条）· 扫链未提供

`eventName = "Heartbeat"`，`payload.args` 为空，`payload.derived` 如下；`eventId = v1:{chainId}:heartbeat:{processedBlock}`。不落审计表，Java 只 upsert `launchpad_v2_indexer_state` 那一行（`heartbeat_at` 取接收时间）。

| 字段 | 含义与说明 | 扫链现状 |
|---|---|---|
| `derived.headBlock` | 【解析】【必须】Envio 看到的链头区块号。与下一项的差 = Envio 落后多少，超阈值告警 | **缺** |
| `derived.processedBlock` | 【解析】【必须】Envio 已处理完的区块号。lag 告警的基准；资产页余额的 `syncedAt` 取它对应的区块时间；落 `launchpad_v2_indexer_state` | **缺** |
| `derived.processedBlockTime` | 【解析】【必须】已处理区块的时间，秒。同上 | **缺** |

没有它 Java 分不清「市场安静」和「Envio 停了」。

## 不发的事件

| 事件 | 原因 | 扫链现状 |
|---|---|---|
| `QuoteAssetConfigured` | Envio 自己订阅、自己存，用来给 TokenLaunched 补精度 / 阈值；Java 不需要这张表 | 没发，正确 |
| `SnipeTaxCharged` `HookFeeCollected` | 费用拆分本期没有读者；`fee` 总额在成交事件里已有。将来做费用区走 FeeEscrow 的台账事件，不逐笔拆 | 没发，正确 |
| `CurveBuyRefunded` | 退款不含在 `grossQuoteIn` 里，不影响任何数 | **在发**，Java 无 handler 会 SKIPPED，无害 |
| `AutoGraduationFailed` | 排查用 | **在发**，同上 |
| `TradeRouter.Launched` | 与同 tx 的首买 CurveBuy 重复 | 没发，正确 |
| `LaunchSwept` `V4PoolGraduated` | 与 CurveCompleted / LaunchGraduated 同 tx 信息重叠（09-21：建池事件改认 LaunchGraduated） | 没发，正确 |
| `Initialize` `ModifyLiquidity` | 建池那一刻的价与流动性 LaunchGraduated 已经带了；第三方加减流动性极少（我们的仓位永久锁定），流动性随下一笔 Swap 自然更新 | **在发**（只发官方池），Java 无 handler，SKIPPED，无害 |
| `Approval` | 无任何用途，量还大 | 09-21 已从 config 去掉 |
| `BuybackEnabledUpdated` | 回购开关只存发币时的值，不追更新 | **在发**，Java 无 handler，SKIPPED，无害 |
| `CreatorFeeRecipientUpdated` `TokenDustLocked` | 当前接口不出这些字段 | 没发，正确 |
| 费用 / 回购 / 治理类 | 本期不做费用区；留 `raw_events`，要用时加 handler 重扫 | 没发，正确 |

## 兼容规则

- `eventName` = ABI 名，`args` 字段名 = ABI 参数名，Envio 不改名；`token` / `curve` 的字段名**以扫链的 `envio/docs` 为准**（用户 09-20 定），`derived` 字段名以本页为准
- 加字段不算破坏；改名、删字段、改类型要换 `eventId` 前缀版本（`v1` → `v2`）并双写一段时间
- Java 的 `ChainEventParser` 只校验信封；`args` / `token` / `curve` / `derived` 由各 handler 取，本页标【必须】的缺了进 FAILED
