---
title: 4 · 消息契约：一个信封、十种事件
---

# 消息契约：一个信封、十种事件

一条消息 = 一条已解码的合约事件日志 + Envio 补的几个字段。信封沿用 `pons.event` 的形状，Java 的解析、审计、去重、重放全部复用。事件名直接用 ABI 名，没有别名。

## topic 与投递

| 项 | 值 |
|---|---|
| topic | `launchpad.chain.event`（一条 topic = 一种发射来源，Java 里对应 `LaunchSource.STORYFUN`） |
| key | token 地址（小写）；`QuoteAssetConfigured` 用 asset 地址 |
| 分区数 | 按吞吐定，≥ Java 消费者并行度 |
| 顺序 | 同一 key 内严格按 `(blockNumber, logIndex)`；跨 key 不保证 |
| 投递 | 至少一次；Java 按 `eventId` 去重 |
| 确认 | 区块落后链头 ≥ N 块才发；`removed` 恒为 `false` |
| 编码 | JSON，UTF-8；uint / int 一律**十进制字符串**；地址、哈希、bytes32 一律 **`0x` 小写**；bool 用 JSON 布尔；string 原样 |

## 信封

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
    "derived": { "…": "Envio 补的字段，各事件不同" }
  }
}
```

| 字段 | 含义 | 变化 |
|---|---|---|
| `eventId` | `v1:{chainId}:{blockHash}:{logIndex}:{removed}`，去重键 | 不变 |
| `eventName` | ABI 事件名 | 不变 |
| `chainId` `blockNumber` `logIndex` | 十进制字符串 | 不变 |
| `blockHash` `txHash` | 小写 | 不变 |
| `blockTimestamp` | 区块时间，秒，十进制字符串 | **必带、非 0**。Java 不再有查区块的兜底 |
| `txFrom` | 交易发起人，小写 | **新增**，备查列 |
| `removed` | 恒 `false` | 语义不变 |
| `payload.address` | 发出日志的合约地址，小写 | 不变 |
| `payload.signature` | 规范签名 | 不变 |
| `payload.args` | ABI 具名参数；struct 展开成对象（如 `socials`） | 不变 |
| `payload.derived` | **新增**。Envio 补的字段，与 `args` 分开放：回放时能分辨是链上原文错还是补字段错 | |

`metadata` 段不再有：自研 `TokenLaunched` 的 metadata 全在 `args` 里。

## 十种事件

「必带」列是 Java 落库要用的；Envio 多给的字段 Java 忽略，加字段不算破坏兼容。

### QuoteAssetConfigured（QuoteAssetRegistry）

| 段 | 字段 |
|---|---|
| args | `asset` `version` `targetNetGraduationQuote` `initialVirtualQuoteReserve` `graduationQuoteThreshold` `decimals` `sourcePriceTimestamp` `enabled` `configHash` |
| derived | 无 |
| Java 写 | `launchpad_quote_asset` upsert（键 `config_hash`） |

### TokenLaunched（LaunchFactory）

| 段 | 字段 |
|---|---|
| args | `token` `curve` `creator` `launchSalt` `quoteAsset` `quoteConfigHash` `launchConfigId` `curveFeeBps` `tickSpacing` `creatorFeeRecipient` `creatorTaxBps` `buybackEnabled` `name` `symbol` `logo` `description` `socials{website, twitter, telegram, discord, farcaster, storyFun}` |
| derived | `quoteDecimals` `initialVirtualQuoteReserve` `graduationQuoteThreshold`（按 `quoteConfigHash` 取）· `totalSupply`（常数 1e9 × 1e18） |
| Java 写 | `launchpad_token` 插入；解析 `socials.storyFun` 绑叙事；反查发行者用户 |

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

| 段 | 字段 |
|---|---|
| args | `buyer` `recipient` `grossQuoteIn` `netQuoteIn` `tokensOut` `fee` |
| derived | `token` · `trader`（名义 = recipient；是合约则按整笔收据里本币 Transfer 净流入最大的地址；解不出退回 recipient。规则见[第 3 页](/envio)）· `snipeTax`（同 tx `SnipeTaxCharged.amount`，没有则 `"0"`）· `quoteReserve` `tokenReserve`（成交后 `trackedNetQuote` / `trackedTokens`）· `priceQuote`（成交后边际价，十进制小数字符串） |
| Java 写 | `launchpad_trade`（CURVE / BUY）；首插成功推进 balance 无关（余额靠 Transfer）、position、kline、protocol_day；币行 set 储备 / 价格 / last_trade_at |

```json
"payload": {
  "address": "0x73d4…31eb",
  "signature": "CurveBuy(address,address,uint128,uint128,uint96,uint128)",
  "args": { "buyer": "0x096a…4fd4", "recipient": "0x2bf5…7675",
            "grossQuoteIn": "100000000000000", "netQuoteIn": "99000000000000",
            "tokensOut": "714285714285714285714285715", "fee": "1000000000000" },
  "derived": { "token": "0x3d7e…4cdd", "trader": "0x2bf5…7675", "snipeTax": "0",
               "quoteReserve": "99000000000000", "tokenReserve": "285714285714285714285714285",
               "priceQuote": "0.000000000000140" }
}
```

### CurveSell（BondingCurve）

| 段 | 字段 |
|---|---|
| args | `seller` `recipient` `tokensIn` `grossQuoteOut` `netQuoteOut` `fee` |
| derived | `token` · `trader`（名义 = seller；是合约则按整笔收据净流出最大的地址）· `quoteReserve` `tokenReserve` `priceQuote` |
| Java 写 | `launchpad_trade`（CURVE / SELL），其余同买入；position 结一笔已实现盈亏 |

### LaunchSwept（LaunchFactory）

| 段 | 字段 |
|---|---|
| args | `token` `quoteAmount` `tokenAmount` |
| Java 写 | 币行 `curve_closed_at` / `pool_quote` / `pool_token`，`status = GRADUATED` |

### V4PoolGraduated（V4GraduationReceiver）

| 段 | 字段 |
|---|---|
| args | `token` `curve` `poolId` `positionId` `sqrtPriceX96` `liquidity` `quoteAmount` `tokenAmount` `tokenDust` `quoteDust` |
| derived | `priceQuote`（由 `sqrtPriceX96` 换算的池初始价，已按 currency0/1 方向与两侧精度处理） |
| Java 写 | 币行 `pool_created_at` `pool_id` `pool_position_id` `pool_liquidity`，`price_quote` |

### PoolRegistered（GraduatedPoolHook）

| 段 | 字段 |
|---|---|
| args | `poolId` `token` `quoteAsset` |
| Java 写 | 币行 `pool_id` / `pool_quote_token`（与 V4PoolGraduated 谁先到谁写） |

### LaunchGraduationRescued（LaunchFactory）

| 段 | 字段 |
|---|---|
| args | `token` `recipient` `quoteAmount` `tokenAmount` |
| Java 写 | 币行 `rescued_at`，`status = RESCUED` |

### Swap（PoolManager，只发我们的池）

| 段 | 字段 |
|---|---|
| args | `id` `sender` `amount0` `amount1` `sqrtPriceX96` `liquidity` `tick` `fee` |
| derived | `token` `poolId` · `side`（BUY / SELL，按本币是 currency0 还是 currency1 与 delta 符号定）· `trader`（**由 Envio 用整笔收据算**：本币 Transfer 净流量，买取净流入最大、卖取净流出最大；解不出为 null。规则见[第 3 页](/envio)）· `tokenAmount` `quoteAmount`（绝对值，最小单位）· `priceQuote`（成交后价）· `hookFee` `creatorTax`（同 tx `HookFeeCollected`；`currency` 也带上，可能是本币也可能是配对资产） |
| Java 写 | `launchpad_trade`（POOL）；trader 为 null 的行照写但不进 position、不进 Activity；币行 `price_quote` / `pool_liquidity` / `last_trade_at` |

```json
"payload": {
  "address": "0xpoolmanager…",
  "signature": "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
  "args": { "id": "0x1dcf…a049", "sender": "0xrouter…", "amount0": "-2500000000000000",
            "amount1": "18000000000000000000000", "sqrtPriceX96": "…", "liquidity": "…", "tick": "-201234", "fee": "3000" },
  "derived": { "token": "0x3d7e…4cdd", "poolId": "0x1dcf…a049", "side": "BUY", "trader": "0x944…",
               "tokenAmount": "18000000000000000000000", "quoteAmount": "2500000000000000",
               "priceQuote": "0.000000000000138", "hookFee": "24999843", "creatorTax": "0",
               "feeCurrency": "0x0000000000000000000000000000000000000000" }
}
```

### Transfer（LaunchToken，只发发射币）

| 段 | 字段 |
|---|---|
| args | `from` `to` `value` |
| derived | 无（`payload.address` 就是 token） |
| Java 写 | `launchpad_transfer` 首插成功 → `launchpad_balance` from 减 to 加；`to` 为零地址减 `total_supply`；余额跨 0 时 `holder_count` ±1 |

一笔曲线买入至少带出一条 Transfer（curve → 用户），经路由时两条；这是消息量的大头，Java 侧按 5.2 的批量消费处理。

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

- `eventName` = ABI 名，`args` 字段名 = ABI 参数名，Envio 不改名
- 加字段不算破坏；改名、删字段、改类型要换 `eventId` 前缀版本（`v1` → `v2`）并双写一段时间
- Java 的 `PonsEventParser` 只校验信封，`args` / `derived` 由各 handler 用 `requireArg` 取，缺了进 FAILED
