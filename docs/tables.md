---
title: 7 · 十二张表：审计、事实、派生、口径
---

# 十二张表：审计、事实、派生、口径

全部在 `mini_drama` 库、`launchpad_` 前缀。约定不变：金额最小单位 `DECIMAL(65,0)`、价格 `DECIMAL(36,18)`、USD `DECIMAL(20,8)`、地址小写 `char(42)`、哈希 `char(66)`、时间毫秒 UTC `BIGINT`。migration 仍只有一个 `V1__launchpad_schema.sql`，直接改，dev / test 库重建。

四类表：**审计**（消息原文与状态）、**事实**（一条日志一行，唯一键幂等）、**派生**（只由事实行首次插入成功推进）、**口径**（定时线写回币行）。

## 审计

```text
launchpad_chain_event                          # 现表，加列改索引。每条消息一行，唯一键 (launch_source, event_id)；重放源
  launch_source          VARCHAR(16)           # storyfun
  event_id               VARCHAR(160)          # v1:{chainId}:{blockHash}:{logIndex}:{removed}
  event_name             VARCHAR(64)           # ABI 事件名
  signature              VARCHAR(255)
  chain_id               BIGINT
  block_number           BIGINT
  block_hash             CHAR(66)
  log_index              INT
  tx_hash                CHAR(66)
  tx_from                CHAR(42)              # 新增，备查
  removed                TINYINT(1)
  block_time             BIGINT                # 必有值
  contract_address       CHAR(42)              # payload.address
  token_address          CHAR(42)              # 新增：derived.token / args.token / Transfer 的 address；按币回放
  raw_message            LONGTEXT              # PROJECTED 且超过 90 天的行清空
  status                 VARCHAR(16)           # RECEIVED / PROJECTED / SKIPPED / FAILED
  attempts               INT
  error                  TEXT
  kafka_partition        INT
  kafka_offset           BIGINT
  received_at            BIGINT
  processed_at           BIGINT
                                               # 索引：uk (launch_source, event_id)；(chain_id, block_number, log_index)；(chain_id, token_address, block_number, log_index)；(status, processed_at)
                                               # 按 received_at 月分区
```

## 事实

```text
launchpad_quote_asset                          # 新表。QuoteAssetConfigured 投影；配对资产精度 / 阈值 / 初始储备的链上权威
  chain_id               BIGINT
  config_hash            CHAR(66)              # 唯一键 (chain_id, config_hash)
  asset_address          CHAR(42)              # 零地址 = 原生 ETH
  version                CHAR(66)
  decimals               TINYINT
  initial_virtual_quote_reserve DECIMAL(65,0)
  graduation_quote_threshold    DECIMAL(65,0)
  target_net_graduation_quote   DECIMAL(65,0)
  enabled                TINYINT(1)
  configured_at          BIGINT                # 区块时间
  created_at / updated_at BIGINT
                                               # 索引 (chain_id, asset_address)

launchpad_trade                                # 新表，替代 launchpad_activity。一笔成交一行；除 pnl_* 与 trader 外不修改
  chain_id               BIGINT
  tx_hash                CHAR(66)
  log_index              INT                   # 唯一键 (chain_id, tx_hash, log_index)
  token_address          CHAR(42)
  venue                  VARCHAR(8)            # CURVE / POOL
  side                   VARCHAR(4)            # BUY / SELL
  trader_address         CHAR(42)              # derived.trader；池内解不出为 NULL
  counterparty_address   CHAR(42)              # CurveBuy.buyer / CurveSell.recipient / Swap.sender
  tx_from                CHAR(42)
  pool_id                CHAR(66)              # 池内才有
  token_amount           DECIMAL(65,0)         # 本币数量，最小单位
  quote_amount           DECIMAL(65,0)         # 配对资产：买 = grossQuoteIn（实付），卖 = netQuoteOut（实收）
  net_quote_amount       DECIMAL(65,0)         # 买 = netQuoteIn，卖 = grossQuoteOut（进出定价储备的部分）
  fee_amount             DECIMAL(65,0)         # 事件 fee 总额；池内 = hookFee
  creator_tax            DECIMAL(65,0)         # 买按 curveFeeBps:creatorTaxBps 比例拆；卖 = grossQuoteOut × creatorTaxBps / 10000；池内 = HookFeeCollected.creatorTax
  snipe_tax              DECIMAL(65,0)         # derived.snipeTax，没有为 0
  quote_amount_whole     DECIMAL(36,18)        # quote_amount 按配对资产精度换算的整枚数
  avg_price_quote        DECIMAL(36,18)        # 这笔均价：net_quote_amount ÷ token_amount；持仓成本用它
  price_quote            DECIMAL(36,18)        # 成交后边际价，derived.priceQuote；K 线用它
  quote_usd_price        DECIMAL(20,8)         # priceAt(配对资产, block_time)；NULL = 缺价
  amount_usd             DECIMAL(20,8)         # quote_amount_whole × quote_usd_price
  cost_quote_released    DECIMAL(36,18)        # 卖出才有：释放的成本，配对资产计
  cost_usd_released      DECIMAL(20,8)
  pnl_quote              DECIMAL(36,18)        # 卖出才有
  pnl_usd                DECIMAL(20,8)
  pnl_pct                DECIMAL(12,4)
  block_number           BIGINT
  block_time             BIGINT
  created_at             BIGINT
                                               # 索引：uk (chain_id, tx_hash, log_index)；(chain_id, token_address, block_time, id)；(chain_id, trader_address, block_time)；(chain_id, block_time)

launchpad_transfer                             # 新表。发射币 Transfer 台账；唯一的用途是让余额累加幂等
  chain_id               BIGINT
  tx_hash                CHAR(66)
  log_index              INT                   # 唯一键 (chain_id, tx_hash, log_index)
  token_address          CHAR(42)
  from_address           CHAR(42)
  to_address             CHAR(42)
  value                  DECIMAL(65,0)
  block_number           BIGINT
  block_time             BIGINT
                                               # 索引：uk；(chain_id, token_address, block_number)。按月分区
```

## 派生

```text
launchpad_balance                              # 新表。一个（币, 地址）一行；Transfer 首插成功时 from 减 to 加
  chain_id               BIGINT
  token_address          CHAR(42)
  holder_address         CHAR(42)              # 唯一键 (chain_id, token_address, holder_address)
  balance                DECIMAL(65,0)
  updated_at             BIGINT
                                               # 索引：(chain_id, token_address, balance DESC)；(chain_id, holder_address)

launchpad_position                             # 新表。一个（地址, 币）一行，永不关闭；移动平均成本
  chain_id               BIGINT
  token_address          CHAR(42)
  trader_address         CHAR(42)              # 唯一键 (chain_id, trader_address, token_address)
  qty_traded             DECIMAL(65,0)         # 买入量 − 卖出量，只算成交
  cost_quote             DECIMAL(36,18)        # 剩余成本，配对资产计
  cost_usd               DECIMAL(20,8)
  bought_qty / sold_qty  DECIMAL(65,0)         # 累计
  bought_quote / sold_quote DECIMAL(36,18)
  bought_usd / sold_usd  DECIMAL(20,8)
  realized_pnl_quote     DECIMAL(36,18)
  realized_pnl_usd       DECIMAL(20,8)
  buy_count / sell_count INT
  first_trade_at / last_trade_at BIGINT
                                               # 索引：(chain_id, trader_address, last_trade_at DESC)

launchpad_kline_minute                         # 新表。只有有成交的分钟才有行
  chain_id               BIGINT
  token_address          CHAR(42)
  period_start           BIGINT                # 整分钟，毫秒；唯一键 (chain_id, token_address, period_start)
  open / high / low / close DECIMAL(36,18)     # 以配对资产计，取成交后价 price_quote
  open_usd / high_usd / low_usd / close_usd DECIMAL(20,8)   # 逐笔按 quote_usd_price 折
  volume_quote_curve     DECIMAL(65,0)         # 曲线成交量
  volume_quote_pool      DECIMAL(65,0)         # 池内成交量；分开存，「含不含 DEX」在读时定
  volume_usd_curve       DECIMAL(20,8)
  volume_usd_pool        DECIMAL(20,8)
  trade_count            INT
                                               # 索引：uk；(chain_id, period_start)

launchpad_kline_day                            # 新表。字段与分钟桶相同，period_start 取整 UTC 日；ALL 档超过 30 天读它
  …

launchpad_protocol_day                         # 新表。UTC 日 × 配对资产一行；协议数据页
  chain_id               BIGINT
  day_index              INT                   # floor(区块时间 / 86400)
  pair_token_address     CHAR(42)              # 唯一键 (chain_id, day_index, pair_token_address)
  volume_quote_curve / volume_quote_pool DECIMAL(65,0)
  volume_usd_curve / volume_usd_pool     DECIMAL(20,8)
  trade_count            INT
```

## 口径

```text
launchpad_token                                # 现表，改列。一个发射币一行，唯一键 (chain_id, token_address)；列表与搜索只读它

  # ── 链上列：TokenLaunched / 毕业 / 成交 handler 写 ──
  launch_source          VARCHAR(16)           # storyfun
  chain_id               BIGINT
  token_address          CHAR(42)
  curve_address          CHAR(42)
  deployer_address       CHAR(42)              # TokenLaunched.creator
  tx_from                CHAR(42)
  pair_token_address     CHAR(42)              # quoteAsset，零地址 = 原生 ETH
  pair_asset             VARCHAR(16)           # 代号：运营名单按地址补；名单外为 NULL，不影响收录
  pair_token_decimals    TINYINT               # derived.quoteDecimals，链上权威
  quote_config_hash      CHAR(66)
  launch_config_id       INT
  curve_fee_bps          SMALLINT UNSIGNED
  creator_tax_bps        SMALLINT UNSIGNED
  tick_spacing           INT
  creator_fee_recipient  CHAR(42)              # 发币时的值，不追更新
  buyback_enabled        TINYINT(1)
  initial_virtual_quote_reserve DECIMAL(65,0)
  graduation_threshold   DECIMAL(65,0)
  total_supply           DECIMAL(65,0)         # 初值 1e9 × 1e18；销毁时减
  token_decimals         TINYINT               # 恒 18
  name / symbol / tagline / image_uri          # metadata 原文
  social_website / social_twitter / social_telegram / social_discord / social_farcaster / social_story_fun
  launch_tx_hash         CHAR(66)
  launch_block_number    BIGINT
  launch_log_index       INT
  launched_at            BIGINT                # 发币区块时间；NEWEST / OLDEST 排序键
  curve_closed_at        BIGINT                # LaunchSwept
  pool_created_at        BIGINT                # V4PoolGraduated
  rescued_at             BIGINT                # LaunchGraduationRescued
  pool_id                CHAR(66)
  pool_quote_token       CHAR(42)
  pool_position_id       DECIMAL(65,0)
  pool_liquidity         DECIMAL(65,0)
  pool_quote / pool_token DECIMAL(65,0)        # LaunchSwept 交给毕业流程的量
  quote_reserve          DECIMAL(65,0)         # derived.quoteReserve；曲线净募集，毕业进度分子；卡片 quoteRaised 读它
  token_reserve          DECIMAL(65,0)
  price_quote            DECIMAL(36,18)        # 最近一笔成交后价，配对资产计
  last_trade_at          BIGINT                # LAST_TRADE 排序键；只往后推
  trade_count            INT
  cum_volume_quote_curve / cum_volume_quote_pool DECIMAL(65,0)
  holder_count           BIGINT                # Transfer handler 维护：余额 > 0 的地址数，含合约；读时剔曲线 / PoolManager

  # ── 口径列：线二写（每分钟） ──
  status                 VARCHAR(16)           # CURVE / GRADUATED / RESCUED，由三个时间戳推
  graduated_at           BIGINT                # = curve_closed_at
  deployer_user_id       BIGINT                # 可空；空 = 卡片只显示地址
  og_key                 VARCHAR(160)
  price_usd              DECIMAL(36,18)        # price_quote × 配对资产现价
  market_cap_usd         DECIMAL(20,8)         # price_usd × total_supply；MARKET_CAP 与已毕业分区排序键
  liquidity_usd          DECIMAL(20,8)         # 曲线：quote_reserve 折美元 × 2；毕业后待定
  deployer_holding_pct   DECIMAL(9,4)          # balance(deployer) ÷ total_supply

  # ── 口径列：线三写（每分钟） ──
  volume_usd_24h         DECIMAL(20,8)         # 滚动 24h Σ amount_usd；VOLUME 排序键；没成交置 0
  price_change_24h       DECIMAL(12,4)

  # ── 删除的列 ──
  market_synced_at · curve_trade_at · quote_raised（改 quote_reserve）
                                               # 列表索引 idx_token_list_* 不动；加 (chain_id, curve_address)、(chain_id, pool_id)、(deployer_address)

launchpad_coin_price                           # 现表。线一每分钟追加；priceAt 与线二都读它
  token_address          CHAR(42)              # 原生币用全零地址
  symbol                 VARCHAR(16)
  price_usd              DECIMAL(20,8)         # 股票代币已乘 currentMultiplier
  source                 VARCHAR(32)           # PriceSource.name()
  priced_at              BIGINT                # 取整到分钟
  created_at             BIGINT
                                               # 索引 (token_address, priced_at)

launchpad_token_content                        # 现表不变。币 ↔ 叙事绑定，TokenLaunched handler 写；一币至多一条
```

## 保留与删除

| 表 | 处置 |
|---|---|
| `launchpad_chain_event` | 保留，加 `tx_from` / `token_address`，改索引，按月分区 |
| `launchpad_token` | 保留，改列（上表） |
| `launchpad_coin_price` `launchpad_token_content` | 保留 |
| `launchpad_quote_asset` `launchpad_trade` `launchpad_transfer` `launchpad_balance` `launchpad_position` `launchpad_kline_minute` `launchpad_kline_day` `launchpad_protocol_day` | 新增 |
| `launchpad_activity` | 删除，被 `launchpad_trade` 取代 |
| `launchpad_ignored_launch` | 删除，全部收录后没有丢弃 |
| `launchpad_volume_snapshot` | 删除，被 `launchpad_protocol_day` 取代 |

## 数据量估算

| 表 | 量级 | 增长 |
|---|---|---|
| `launchpad_chain_event` | 最大：每笔成交 2～4 条消息（成交 + Transfer） | 按每天 1 万笔成交估一年约 1,100 万行；raw_message 90 天后清空，按月分区 |
| `launchpad_trade` | 币数 × 平均成交笔数，几十万到几百万行 | 只增不改，普通索引足够 |
| `launchpad_transfer` | ≈ 成交笔数 × 1.5 | 按月分区；只做幂等判断，可与审计表同期清理 |
| `launchpad_balance` | 币数 × 持有地址数，十万级 | 只更新 |
| `launchpad_kline_minute` | ≤ 成交笔数 | 只有有成交的分钟才有行 |
| `launchpad_position` | 交易过的（地址 × 币）数 | 只更新 |
| `launchpad_protocol_day` | 天数 × 配对资产数 | 每天几行 |
| `launchpad_coin_price` | 资产数 × 每分钟一行 | 六个资产一年约 300 万行 |
