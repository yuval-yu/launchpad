---
title: 7 · 从零建表：十一张
---

# 从零建表：十一张

线上数据不要了，旧表全部 DROP，按新方案重新设计，不看旧结构、不留兼容列。全部在 `mini_drama` 库、`launchpad_` 前缀；**只有一个 migration `V1__launchpad_schema.sql`**，开头先 `DROP TABLE IF EXISTS` 全部 `launchpad_*` 旧表再建。

约定：金额最小单位 `DECIMAL(65,0)`；以配对资产计的价格 `DECIMAL(36,18)`；USD `DECIMAL(20,8)`；地址小写 `CHAR(42)`；哈希 / bytes32 小写 `CHAR(66)`；时间毫秒 UTC `BIGINT`；每张表 `id BIGINT UNSIGNED AUTO_INCREMENT` 主键、`InnoDB` + `utf8mb4_unicode_ci`、每列带 `COMMENT`。命名跟合约走：合约叫 `quoteAsset`，表里就叫 `quote_asset_*`（对外 DTO 的 `pairAsset` 等字段名不变，映射在 Java）。只接一条链，`chain_id` 列保留但不做多链逻辑。

四类表：**审计**（消息原文与状态，重放源）、**事实**（一条日志一行，唯一键幂等；余额是消息给的绝对值，也归这类）、**派生**（只由成交事实行首次插入成功推进）、**口径**（handler 与定时线写、读接口读）。

## 审计

```text
launchpad_chain_event                          # 一条消息一行；唯一键 event_id；重放源
  event_id               VARCHAR(160)          # v1:{chainId}:{blockHash}:{logIndex}:{removed}
  event_name             VARCHAR(64)           # ABI 事件名
  signature              VARCHAR(255)          # 规范签名
  chain_id               BIGINT
  block_number           BIGINT
  block_hash             CHAR(66)
  log_index              INT
  tx_hash                CHAR(66)
  tx_from                CHAR(42)
  block_time             BIGINT                # 毫秒；消息必带
  contract_address       CHAR(42)              # payload.address
  token_address          CHAR(42)              # 该事件属于哪个币（derived.token / args.token / Transfer 的 address）；QuoteAssetConfigured 为 NULL
  raw_message            LONGTEXT              # 原文；只保留最近 3 个月的分区，更早 DROP PARTITION
  status                 VARCHAR(16)           # RECEIVED / PROJECTED / SKIPPED / FAILED / WAITING_TOKEN（币还没到，不计次数，TokenLaunched 到了按币重投）
  attempts               INT
  error                  TEXT
  kafka_partition        INT
  kafka_offset           BIGINT
  received_at            BIGINT
  processed_at           BIGINT
                                               # uk (event_id, block_time)；(chain_id, block_number, log_index)；(chain_id, token_address, block_number, log_index)；(status, processed_at)
                                               # 按 block_time 月分区（分区列必须在唯一键里；不能用 received_at，见「库与分区」）
```

## 事实

```text
launchpad_quote_asset                          # QuoteAssetConfigured 投影；配对资产精度 / 阈值 / 初始储备的链上权威
  chain_id               BIGINT
  config_hash            CHAR(66)              # uk (chain_id, config_hash)
  asset_address          CHAR(42)              # 零地址 = 原生 ETH
  version                CHAR(66)
  decimals               TINYINT
  initial_virtual_quote_reserve DECIMAL(65,0)
  graduation_quote_threshold    DECIMAL(65,0)
  target_net_graduation_quote   DECIMAL(65,0)
  enabled                TINYINT(1)
  configured_at          BIGINT                # 区块时间
  created_at / updated_at BIGINT
                                               # (chain_id, asset_address)

launchpad_trade                                # 一笔成交一行；只插入不更新（盈亏在插入前按持仓算好）
  chain_id               BIGINT
  tx_hash                CHAR(66)
  log_index              INT                   # uk (chain_id, tx_hash, log_index, block_time)；按 block_time 月分区
  token_address          CHAR(42)
  venue                  VARCHAR(8)            # CURVE / POOL
  side                   VARCHAR(4)            # BUY / SELL
  trader_address         CHAR(42)              # derived.trader；池内解不出为 NULL
  counterparty_address   CHAR(42)              # CurveBuy.buyer / CurveSell.recipient / Swap.sender
  tx_from                CHAR(42)
  pool_id                CHAR(66)              # 池内才有
  token_amount           DECIMAL(65,0)         # 本币数量
  quote_amount           DECIMAL(65,0)         # 配对资产：买 = grossQuoteIn（实付），卖 = netQuoteOut（实收）
  net_quote_amount       DECIMAL(65,0)         # 买 = netQuoteIn，卖 = grossQuoteOut（进出定价储备的部分）
  fee_amount             DECIMAL(65,0)         # 事件 fee 总额；池内 = hookFee
  base_fee               DECIMAL(65,0)         # derived.baseFee
  creator_tax            DECIMAL(65,0)         # derived.creatorTax；池内 = HookFeeCollected.creatorTax
  snipe_tax              DECIMAL(65,0)         # derived.snipeTax，没有为 0
  quote_amount_whole     DECIMAL(36,18)        # quote_amount 按 quote_asset_decimals 换算的整枚数
  avg_price_quote        DECIMAL(36,18)        # 这笔均价：net_quote_amount ÷ token_amount；持仓成本用它
  price_quote            DECIMAL(36,18)        # 成交后边际价，derived.priceQuote；K 线用它
  quote_usd_price        DECIMAL(20,8)         # priceAt(配对资产, block_time)：已知的最近一行，不看多旧；NULL 只在该资产从未有价时
  amount_usd             DECIMAL(20,8)         # quote_amount_whole × quote_usd_price
  cost_quote_released    DECIMAL(36,18)        # 卖出才有：释放的成本；插入前用卖出前的持仓算好，不回填
  cost_usd_released      DECIMAL(20,8)
  pnl_quote              DECIMAL(36,18)        # 卖出才有
  pnl_usd                DECIMAL(20,8)
  pnl_pct                DECIMAL(12,4)
  block_number           BIGINT
  block_time             BIGINT
  created_at             BIGINT
                                               # uk；(chain_id, token_address, block_time, id)；(chain_id, trader_address, block_time)；(chain_id, block_time)

launchpad_balance                              # 一个（币, 地址）一行；Transfer 消息里的 fromBalance / toBalance 直接 set，不累加
  chain_id               BIGINT
  token_address          CHAR(42)
  holder_address         CHAR(42)              # uk (chain_id, token_address, holder_address)
  holder_kind            VARCHAR(16)           # derived.fromKind / toKind：USER / CURVE / POOL_MANAGER / FACTORY / RECEIVER / LOCKER / ROUTER / VAULT；持有者榜标行、剔协议合约、资产页只列 USER
  balance                DECIMAL(65,0)
  block_number           BIGINT                # 水位线：只接受 (block_number, log_index) 更新的 Transfer（乱序保护）
  log_index              INT
  updated_at             BIGINT
                                               # (chain_id, token_address, balance DESC)；(chain_id, holder_address)
```

## 派生

```text
launchpad_position                             # 一个（地址, 币）一行，永不关闭；移动平均成本
  chain_id               BIGINT
  token_address          CHAR(42)
  trader_address         CHAR(42)              # uk (chain_id, trader_address, token_address)
  qty_traded             DECIMAL(65,0)         # 买入量 − 卖出量，只算成交
  cost_quote             DECIMAL(36,18)        # 剩余成本，配对资产计
  cost_usd               DECIMAL(20,8)
  bought_qty / sold_qty  DECIMAL(65,0)
  bought_quote / sold_quote DECIMAL(36,18)
  bought_usd / sold_usd  DECIMAL(20,8)
  realized_pnl_quote     DECIMAL(36,18)
  realized_pnl_usd       DECIMAL(20,8)
  buy_count / sell_count INT
  first_trade_at / last_trade_at BIGINT
  applied_block / applied_log BIGINT / INT     # 最后一笔按顺序应用的成交；更早的成交迟到 → 重算这一对
                                               # (chain_id, trader_address, last_trade_at DESC)

launchpad_kline_minute                         # 只有有成交的分钟才有行（用户 09-18 定）：桶由成交 handler upsert，没有任何定时任务补空桶
  chain_id               BIGINT
  token_address          CHAR(42)
  period_start           BIGINT                # 整分钟；uk (chain_id, token_address, period_start)
  open / high / low / close DECIMAL(36,18)     # 配对资产计，取成交后价 price_quote
  open_block / open_log  BIGINT / INT          # open 来自哪笔成交；迟到的更早一笔替换 open（乱序保护）
  close_block / close_log BIGINT / INT         # close 来自哪笔成交；更晚的才替换 close
  open_usd / high_usd / low_usd / close_usd DECIMAL(20,8)
  volume_quote_curve     DECIMAL(65,0)         # 曲线成交量
  volume_quote_pool      DECIMAL(65,0)         # 池内成交量；分开存，「含不含 DEX」读时定
  volume_usd_curve       DECIMAL(20,8)
  volume_usd_pool        DECIMAL(20,8)
  trade_count            INT
                                               # uk；(chain_id, period_start)

launchpad_kline_day                            # 字段同分钟桶，period_start 取整 UTC 日；同样只有有成交的日才有行；ALL 档超过 30 天读它

launchpad_protocol_day                         # UTC 日 × 配对资产一行；协议数据页
  chain_id               BIGINT
  day_index              INT                   # floor(区块时间 / 86400)
  quote_asset_address    CHAR(42)              # uk (chain_id, day_index, quote_asset_address)
  volume_quote_curve / volume_quote_pool DECIMAL(65,0)
  volume_usd_curve / volume_usd_pool     DECIMAL(20,8)
  trade_count            INT
```

## 口径

```text
launchpad_token                                # 一个发射币一行，uk (chain_id, token_address)；列表与搜索只读它

  # ── 链上列：TokenLaunched / 毕业 / 成交 / Transfer handler 写 ──
  chain_id               BIGINT
  token_address          CHAR(42)
  curve_address          CHAR(42)
  creator_address        CHAR(42)              # TokenLaunched.creator；对外仍叫 deployerAddress
  tx_from                CHAR(42)
  quote_asset_address    CHAR(42)              # 零地址 = 原生 ETH
  quote_asset_symbol     VARCHAR(16)           # 运营名单按地址补；名单外用 derived.quoteSymbol
  quote_asset_decimals   TINYINT               # derived.quoteDecimals，链上权威
  quote_config_hash      CHAR(66)
  launch_config_id       INT
  curve_fee_bps          SMALLINT UNSIGNED
  creator_tax_bps        SMALLINT UNSIGNED
  tick_spacing           INT
  creator_fee_recipient  CHAR(42)              # 发币时的值，不追更新
  buyback_enabled        TINYINT(1)
  initial_virtual_quote_reserve DECIMAL(65,0)
  graduation_threshold   DECIMAL(65,0)
  total_supply           DECIMAL(65,0)         # derived.totalSupply，Transfer 消息 set
  token_decimals         TINYINT               # derived.tokenDecimals
  name                   VARCHAR(128)
  symbol                 VARCHAR(32)
  description            VARCHAR(512)          # 对外 tagline
  logo_uri               VARCHAR(512)          # 对外 imageUri
  social_website / social_twitter / social_telegram / social_discord / social_farcaster / social_story_fun  VARCHAR(255)
  launch_tx_hash         CHAR(66)
  launch_block_number    BIGINT
  launch_log_index       INT
  launched_at            BIGINT                # 发币区块时间；NEWEST / OLDEST 排序键
  curve_closed_at        BIGINT                # LaunchSwept
  pool_created_at        BIGINT                # V4PoolGraduated
  rescued_at             BIGINT                # LaunchGraduationRescued
  pool_id                CHAR(66)              # Uniswap v4 poolId，只作标识（前端拼链接、与 Swap 对照）；池的其它信息不存
  swept_quote / swept_token DECIMAL(65,0)      # LaunchSwept 交给毕业流程的量
  quote_reserve          DECIMAL(65,0)         # derived.quoteReserve：曲线净募集，毕业进度分子（对外 quoteRaised）；曲线关闭后冻结
  liquidity_quote        DECIMAL(65,0)         # derived.liquidityQuote：流动性，以配对资产计；曲线与池内成交都推进
  token_reserve          DECIMAL(65,0)
  price_quote            DECIMAL(36,18)        # 最近一笔成交后价，配对资产计
  state_block_number     BIGINT                # set 型链上列的水位线：只接受 (block, log) 更新的事件（乱序保护）
  state_log_index        INT
  last_trade_at          BIGINT                # LAST_TRADE 排序键；只往后推
  trade_count            INT
  cum_volume_quote_curve / cum_volume_quote_pool DECIMAL(65,0)
  holder_count           BIGINT                # derived.positiveBalanceCount，Transfer 消息 set；含合约，读时剔曲线 / PoolManager

  # ── 口径列：线二写（每分钟） ──
  status                 VARCHAR(16)           # CURVE / GRADUATED / RESCUED，由三个时间戳推
  graduated_at           BIGINT                # = curve_closed_at
  creator_user_id        BIGINT                # 可空；空 = 卡片只显示地址。对外 deployerUser
  og_key                 VARCHAR(160)
  price_usd              DECIMAL(36,18)        # price_quote × 配对资产现价
  market_cap_usd         DECIMAL(20,8)         # price_usd × total_supply；MARKET_CAP 与已毕业分区排序键
  liquidity_usd          DECIMAL(20,8)         # liquidity_quote × 配对资产价
  creator_holding_pct    DECIMAL(9,4)          # balance(creator) ÷ total_supply；对外 deployerHoldingPct

  # ── 口径列：线三写（每分钟） ──
  volume_usd_24h         DECIMAL(20,8)         # 滚动 24h Σ amount_usd；VOLUME 排序键；没成交置 0
  price_change_24h       DECIMAL(12,4)

  created_at / updated_at BIGINT
                                               # uk (chain_id, token_address)；(chain_id, curve_address)；(chain_id, pool_id)；(creator_address)；(creator_user_id)；(og_key)
                                               # 列表：(chain_id, status, last_trade_at)、(chain_id, status, market_cap_usd)、(chain_id, status, volume_usd_24h)、(chain_id, status, launched_at)

launchpad_coin_price                           # 配对资产美元价历史；线一每分钟追加；priceAt 与线二都读它
  asset_address          CHAR(42)              # 原生币用全零地址
  symbol                 VARCHAR(16)
  price_usd              DECIMAL(20,8)         # 股票代币已乘 currentMultiplier
  source                 VARCHAR(32)           # PriceSource.name()
  priced_at              BIGINT                # 取整到分钟
  created_at             BIGINT
                                               # (asset_address, priced_at)

launchpad_token_content                        # 币 ↔ 叙事绑定，TokenLaunched handler 写；一币至多一条
  chain_id               BIGINT
  token_address          CHAR(42)              # uk (chain_id, token_address)
  content_type           VARCHAR(8)            # DRAMA / VIDEO
  content_id             BIGINT                # drama.id 或 drama_episode.id
  bound_at               BIGINT
  created_at             BIGINT
                                               # (content_type, content_id)
```

## 只读别人的表（不在 V1 里）

`user_wallet_address` / `users`（归 user-wallet）：发行者反查与昵称头像；`drama` / `drama_episode`（归 app）：叙事绑定校验与卡片。规则不变。

## 数据量：三档估算

一笔成交平均带出 2.5 条消息（成交 + 1～2 条 Transfer）。`launchpad_chain_event` 每行含 `raw_message` 约 1.5 KB，其余表每行 100～300 B。

| 日成交笔数 | 消息 / 天 | `chain_event` 一年 | `trade` 一年 | 其余表 |
|---|---|---|---|---|
| **1 千**（冷启动） | 2.5 千 | 90 万行 · 1.4 GB | 36 万行 · 0.1 GB | 都在十万行以下 |
| **1 万**（正常） | 2.5 万 | 900 万行 · 14 GB | 365 万行 · 1 GB | `kline_minute` ≤ 365 万行；`balance` 十万级 |
| **10 万**（火爆） | 25 万 | 9 千万行 · 140 GB | 3,650 万行 · 10 GB | `kline_minute` 千万级 |

写入压力不是问题：10 万笔 / 天平均 3 条消息 / 秒，峰值按 50 倍算也就 150 条 / 秒，批量插入一条 SQL 就吃掉了。**问题只有一个：`chain_event` 的 `raw_message`**，它占了全部体积的 90% 以上。

## 库与分区：建议

**不建独立库（用户 09-18 定）。** 前期只有审计表大，体积靠按月分区 + 月度 `DROP PARTITION` 解决，其余表都在千万行以下，放 `mini_drama` 库即可。将来要不要拆，看两个信号：日成交稳定超过 5 万笔，或 `mini_drama` 实例上其他服务的慢查询能对应到 launchpad 的写入高峰。真要拆代价也小：launchpad 读 `users` / `user_wallet_address` / `drama` / `drama_episode` 的四处本来就是应用层单独查、没有 SQL JOIN，整库挪走只改一个 JDBC URL。

**不分表。** 热查询全部带 `token_address` 或 `trader_address` 走索引，千万行级别 MySQL 单表没有压力；分表只会把「按币查」「按人查」两种访问路径拆到两个维度上，得不偿失。

**按月分区，两张表。**

| 表 | 分区键 | 保留 | 唯一键要求 |
|---|---|---|---|
| `launchpad_chain_event` | `block_time` 的月份 | 最近 3 个月保留原文；更早的整个分区 `DROP PARTITION`（Envio 可重扫重投） | MySQL 要求唯一键包含分区列：`uk (event_id, block_time)`。**不能用 `received_at` 分区**：同一 eventId 重复投递时 `received_at` 不同，唯一键就拦不住重复 |
| `launchpad_trade` | `block_time` 的月份 | 永久 | `uk (chain_id, tx_hash, log_index, block_time)`，同一笔日志的 `block_time` 固定，去重不受影响 |

其余表不分区。`DROP PARTITION` 是秒级元数据操作，比 `DELETE … WHERE` 清一亿行便宜几个数量级，这是分区的主要收益。

**可选的进一步减肥**：Transfer 是消息的大头、又只用来 set 余额，可以只落审计行不存 `raw_message`（Envio 的 `raw_events` 才是原文），`chain_event` 体积再降一半以上。要不要这么做等第一个月看真实量再定。
