---
title: 7 · Envio 九个实体，MySQL 三张表
---

# Envio 九个实体，MySQL 三张表

Envio 的 Postgres 由它按 `schema.graphql` 生成，实体见[第 4 页](/indexer)；Java 读路径走 Hasura，批量聚合可用只读账号。 MySQL 侧全部在 `mini_drama` 库、`launchpad_` 前缀，金额最小单位 `DECIMAL(65,0)`，地址小写 `char(42)`。

## MySQL

```text
launchpad_token                                # 现表，改列。只有市场列表与搜索读它；一个发射币一行，唯一键 (chain_id, token_address)

  # ── 链上列：Token 同步器写，来自 Envio 的 Token 实体，整行覆盖 ──
  chain_id               BIGINT                # 链 id
  token_address          CHAR(42)              # 代币地址，小写
  curve_address          CHAR(42)              # 曲线合约地址
  deployer_address       CHAR(42)              # 发行者地址
  pair_token_address     CHAR(42)              # 配对资产地址
  pair_asset             VARCHAR(16)           # 配对资产代号，来自 Envio 读的 symbol() 或运营名单
  pair_token_decimals    TINYINT               # 配对资产精度，来自链上 QuoteAssetRegistry 的配置；不依赖运营名单
  curve_fee_bps          SMALLINT UNSIGNED     # 基础手续费 BPS，发币时快照
  creator_fee_recipient  CHAR(42)              # 当前创作者费收款人，可变
  buyback_enabled        TINYINT(1)            # 当前回购开关，可变
  graduation_threshold   DECIMAL(65,0)         # 毕业阈值，最小单位
  creator_tax_bps        SMALLINT UNSIGNED     # 创作者税 BPS
  total_supply           DECIMAL(65,0)         # 总供应；流通量恒等于它
  locked_supply          DECIMAL(65,0)         # 锁定供应，只存不用
  token_decimals         TINYINT               # 代币精度
  name                   VARCHAR(128)          # 币名，metadata 原文
  symbol                 VARCHAR(32)           # 代号
  tagline                VARCHAR(512)          # 一句话简介
  image_uri              VARCHAR(512)          # 币图 URI，不清洗
  social_website         VARCHAR(255)          # 普通官网链接，原样返回；storyFun 为空时才拿它试绑定
  social_twitter         VARCHAR(255)          # 社交链接
  social_telegram        VARCHAR(255)          # 社交链接
  social_discord         VARCHAR(255)          # 社交链接
  social_farcaster       VARCHAR(255)          # 社交链接
  social_story_fun       VARCHAR(255)          # Story.Fun 主页 / 发射页链接；叙事绑定解析它
  launch_tx_hash         CHAR(66)              # 发币交易哈希
  launch_block_number    BIGINT                # 发币区块号
  launched_at            BIGINT                # 发币时间，毫秒 UTC；NEWEST / OLDEST 排序键、币龄窗口过滤
  tx_from                CHAR(42)              # 发币交易的 from
  curve_closed_at        BIGINT                # 曲线关闭时间，毫秒；空 = 未毕业
  rescued_at             BIGINT                # 治理释放储备的时间；终态，展示口径待产品定
  pool_position_id       DECIMAL(65,0)         # 锁定的 PositionManager NFT id
  pool_created_at        BIGINT                # 池建好时间，毫秒
  pool_id                CHAR(66)              # Uniswap v4 poolId
  pool_quote_token       CHAR(42)              # 池的计价资产地址
  pool_liquidity         DECIMAL(65,0)         # 池内当前流动性
  net_quote_raised       DECIMAL(65,0)         # 曲线净募集；卡片 quoteRaised 读它
  cum_volume_curve       DECIMAL(65,0)         # 曲线累计成交量，配对资产最小单位
  cum_volume_pool        DECIMAL(65,0)         # 池内累计成交量
  trade_count            INT                   # 累计成交笔数
  last_price_quote       DECIMAL(36,18)        # 最后成交价，配对资产计
  last_trade_at          BIGINT                # 最后成交时间，毫秒；LAST_TRADE 排序键
  positive_balance_count INT                   # 正余额地址数，含合约
  updated_at_block       BIGINT                # Envio 的 updatedAtBlock，同步游标依据

  # ── 口径列：线二写，每分钟 ──
  deployer_user_id       BIGINT                # 反查到的平台用户 id，可空；空 = 卡片只显示地址
  price_source           VARCHAR(16)           # 该币配对资产的价源：STABLE / BINANCE / ROBINHOOD / NONE；NONE = 名单外，USD 列全空
  status                 VARCHAR(16)           # CURVE / GRADUATED，由 curve_closed_at 推出
  graduated_at           BIGINT                # = curve_closed_at，卡片 graduatedAt
  price_usd              DECIMAL(36,18)        # last_price_quote × 配对资产现价
  market_cap_usd         DECIMAL(20,8)         # price_usd × total_supply；MARKET_CAP 排序键、已毕业分区排序键
  liquidity_usd          DECIMAL(20,8)         # 曲线阶段：净募集折美元；毕业后：池储备折美元
  holder_count           BIGINT                # 正余额地址数剔除 curve / PoolManager / 锁仓合约
  deployer_holding_pct   DECIMAL(9,4)          # 发行者余额 ÷ 总供应，百分比数；> 20 出警示徽标
  og_key                 VARCHAR(160)          # 同名同代号分组键，组内 launched_at 最早的为 OG

  # ── 口径列：线三写，每 5 分钟 ──
  volume_usd_24h         DECIMAL(20,8)         # 严格滚动 24h 成交额；VOLUME 排序键；没成交置 0
  price_change_24h       DECIMAL(12,4)         # 24h 涨跌，百分比数

  # ── 删除的列 ──
  market_synced_at                             # CMC 写回时间，不再需要
  curve_trade_at                               # CMC 刷新的活跃信号，不再需要
  quote_raised                                 # 被 net_quote_raised 取代

launchpad_coin_price                           # 现表，改为多行历史。线一每分钟写；Envio 的取价 Effect 与 Java 线二都读它
  id                     BIGINT                # 自增
  token_address          CHAR(42)              # 配对资产地址；原生币用全零地址
  symbol                 VARCHAR(16)           # 代号，展示与排查用
  price_usd              DECIMAL(20,8)         # 一枚该资产的美元价；股票代币已乘 currentMultiplier
  source                 VARCHAR(32)           # STABLE / BINANCE / ROBINHOOD
  granularity            VARCHAR(8)            # MINUTE / HOUR；小时行给长窗口用
  priced_at              BIGINT                # 该行代表的时刻，取整到分钟或小时；Effect 按「≤ 区块时间的最近一行」取
  created_at             BIGINT                # 写入时间
                                               # 索引 (token_address, granularity, priced_at)

launchpad_token_content                        # 现表不变。币 ↔ 叙事绑定，线二写；一个币至多一条
  chain_id               BIGINT                # 链 id
  token_address          CHAR(42)              # 代币地址；唯一键 (chain_id, token_address)
  content_type           VARCHAR(8)            # DRAMA / VIDEO
  content_id             BIGINT                # drama.id 或 drama_episode.id
  bound_at               BIGINT                # 绑定时间，毫秒

launchpad_sync_cursor                          # 新表，一条链一行
  chain_id               BIGINT                # 链 id
  last_block             BIGINT                # Token 同步到的 updatedAtBlock
  updated_at             BIGINT                # 最后一轮同步时间
```

## Envio Postgres（只读）

| 实体 | 谁读 | 怎么读 |
|---|---|---|
| `Token` | Token 同步器 | GraphQL，按 `updatedAtBlock` |
| `Trade` | K 线 M5、成交页签、Activity | GraphQL，按币 / 按 trader，id 游标 |
| `CandleMinute` / `CandleHour` / `CandleDay` | K 线、线三 | GraphQL；线三也可只读账号 `GROUP BY` |
| `Balance` | 持有者榜、资产页余额、线二 | GraphQL，按币余额倒序 / 按地址 |
| `Position` | 持仓页、按币汇总的历史 | GraphQL，按 trader |
| `QuoteAssetConfig` | 线二（配对资产名单与精度） | GraphQL，几十行 |
| `ProtocolDay` | 线四 | GraphQL，90 行 |
| `raw_events`（系统表） | 审计、对账、将来补 handler 的原料 | 取代 `launchpad_chain_event`；退款、费用清扫、配置变更只在这里 |

## 保留与删除

| 表 | 处置 | 说明 |
|---|---|---|
| `launchpad_token` | 保留，改列 | CMC 回写列改由线二 / 线三写；加累加列、`price_source`、`pool_quote_token`、`pool_liquidity`、`updated_at_block`；`deployer_user_id` 改为可空；删 `market_synced_at`、`curve_trade_at`、`quote_raised` |
| `launchpad_token_content`、`launchpad_coin_price` | 保留 | 价格表加 granularity 列并允许多行历史 |
| `launchpad_sync_cursor` | 新增 | 一行 |
| `launchpad_chain_event` | 删除 | Kafka 审计表；原始日志审计改看 Envio 的 `raw_events` |
| `launchpad_ignored_launch` | 删除 | 负向过滤表，全部收录后没有丢弃 |
| `launchpad_activity` | 删除 | Activity 直接查 Envio 的 `Trade` 按 trader |
| `launchpad_volume_snapshot` | 删除 | 整点快照机制随 `ProtocolDay` 消失 |

migration 仍只有一个 `V1__launchpad_schema.sql`，直接改；dev / test 库重建。没上线、无旧数据，不留兼容。
