---
title: 7 · 从零建表：十张
---

# 从零建表：十张

线上数据不要了，按新方案从零设计，不看旧结构、不留兼容列。全部在 `mini_drama` 库，**表名前缀 `launchpad_v2_`**（用户 09-19 定，与上一版的 `launchpad_*` 区分，两套表可以并存）；**只有一个 migration `V1__launchpad_v2_schema.sql`**，只建新表。旧 `launchpad_*` 表不在这份脚本里，**一律不动**，删不删以后再定。

约定：金额最小单位 `DECIMAL(65,0)`；以配对资产计的价格 `DECIMAL(36,18)`；USD `DECIMAL(20,8)`；地址小写 `CHAR(42)`；哈希 / bytes32 小写 `CHAR(66)`；时间毫秒 UTC `BIGINT`；每张表 `id BIGINT UNSIGNED AUTO_INCREMENT` 主键、`InnoDB` + `utf8mb4_unicode_ci`、每列带 `COMMENT`。命名跟合约走：合约叫 `quoteAsset`，表里就叫 `quote_asset_*`（对外 DTO 的 `pairAsset` 等字段名不变，映射在 Java）。只接一条链，`chain_id` 列保留但不做多链逻辑：消息里 chainId 与配置不符的在解析层就进死信，进不了任何表；**`chain_id` 不进任何索引和唯一键**（用户 09-18 定，单值列放索引首位没有选择性，只撑长索引）。

四类表：**审计**（消息原文与状态，重放源）、**事实**（一条日志一行，唯一键幂等；余额是消息给的绝对值，也归这类）、**派生**（只由成交事实行首次插入成功推进）、**口径**（handler 与定时线写、读接口读）。

## 审计

```text
launchpad_v2_chain_event                          # 一条消息一行；唯一键 event_id；重放源
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
  token_address          CHAR(42)              # 这条事件属于哪个发射币，给按币回放用
  raw_message            LONGTEXT              # 原文；只保留最近 3 个月的分区，更早 DROP PARTITION
  status                 VARCHAR(16)           # RECEIVED / PROJECTED / SKIPPED / FAILED / WAITING_TOKEN（币还没到，不计次数，TokenLaunched 到了按币重投）
  attempts               INT
  error                  TEXT
  kafka_key              VARCHAR(66)           # 消息的分区键（应 = token 地址），排障核对
  kafka_partition        INT
  kafka_offset           BIGINT
  received_at            BIGINT
  processed_at           BIGINT
                                               # PK  (id, block_time)
                                               # UK  (event_id, block_time)                       去重键；block_time 只为满足分区规则，不参与查找
                                               # IDX (block_number, log_index)                    全量重建按链上顺序读
                                               # IDX (token_address, block_number, log_index)     按币回放
                                               # IDX (status, processed_at)                       重投任务捞 FAILED / WAITING_TOKEN
                                               # 按 block_time 月分区。分区表的每个唯一索引（含主键）必须含分区列，所以 PK / UK 末尾带 block_time；同一 event_id 的 block_time 恒相同，去重不受影响。不能用 received_at 分区，见「库与分区」
```

## 事实

```text
launchpad_v2_trade                                # 一笔成交一行；只插入不更新（盈亏在插入前按持仓算好）
  chain_id               BIGINT
  tx_hash                CHAR(66)
  log_index              INT                   # 这条成交日志在区块里的序号；和 tx_hash 一起唯一标识一笔成交
  token_address          CHAR(42)              # 成交的是哪个发射币
  venue                  VARCHAR(8)            # 在哪成交：CURVE = 曲线阶段，POOL = 毕业后的 Uniswap 池
  side                   VARCHAR(4)            # BUY = 用户拿配对资产买币，SELL = 用户卖币换回配对资产
  trader_address         CHAR(42)              # 真正买卖的那个人的钱包地址：曲线成交 = 收币 / 卖币的地址（消息给了穿透结果就用穿透结果）；池内成交由消息给，偶尔认不出来为 NULL
  counterparty_address   CHAR(42)              # 交易的另一方：买入时是发起调用的地址（经路由时是路由），卖出时是收款地址，池内是路由
  tx_from                CHAR(42)              # 这笔交易链上的发起人；用 gasless 时是中继地址，所以只作备查
  pool_id                CHAR(66)              # 池内成交才有：在哪个 Uniswap 池成交的
  token_amount           DECIMAL(65,0)         # 成交了多少枚发射币（最小单位，未除精度）
  quote_amount           DECIMAL(65,0)         # 用户实际付出（买）或实际收到（卖）的配对资产数量（最小单位），含手续费。**这是成交额**
  net_quote_amount       DECIMAL(65,0)         # 去掉手续费后真正进出曲线储备的配对资产数量（最小单位）；算这笔的均价用它
  fee_amount             DECIMAL(65,0)         # 这笔一共扣了多少手续费（配对资产最小单位）；本期不拆分不展示，只存档
  quote_amount_whole     DECIMAL(36,18)        # quote_amount 除以配对资产精度后的「整枚」数，直接可读，比如 1.5 ETH 或 200 USDG
  avg_price_quote        DECIMAL(36,18)        # 这笔的成交均价：每枚发射币花了多少配对资产 = net_quote_amount ÷ token_amount；持仓成本按它算
  price_quote            DECIMAL(36,18)        # 这笔成交完成后币的最新价：一枚发射币值多少配对资产；K 线的点用它
  quote_usd_price        DECIMAL(20,8)         # 成交那一刻一枚配对资产值多少美元（取价格历史表里区块时间之前最近的一条）；从未有过价才 NULL
  amount_usd             DECIMAL(20,8)         # 这笔成交折成美元是多少 = quote_amount_whole × quote_usd_price
  cost_quote_released    DECIMAL(36,18)        # 卖出才有：这次卖掉的币当初是花多少配对资产买的（按移动平均成本算），用来算盈亏
  cost_usd_released      DECIMAL(20,8)         # 同上，美元口径
  pnl_quote              DECIMAL(36,18)        # 卖出才有：这次卖赚了或亏了多少配对资产 = 实收 − 当初成本
  pnl_usd                DECIMAL(20,8)         # 同上，美元口径
  pnl_pct                DECIMAL(12,4)         # 同上，百分比：赚 / 亏了成本的百分之几
  block_number           BIGINT                # 成交在哪个区块
  block_time             BIGINT                # 成交时间（区块时间，毫秒）
  created_at             BIGINT                # 这行写进库的时间
                                               # PK  (id, block_time)
                                               # UK  (tx_hash, log_index, block_time)             一条日志一行；block_time 只为满足分区规则
                                               # IDX (token_address, block_time, id)              成交页签、K 线 M5、按币回放
                                               # IDX (trader_address, block_time)                 Activity、持仓重算
                                               # IDX (block_time)                                 线三 24h、协议日
                                               # 按 block_time 月分区

launchpad_v2_balance                              # 一个（币, 地址）一行；Transfer 消息里的 fromBalance / toBalance 直接 set，不累加
  chain_id               BIGINT
  token_address          CHAR(42)
  holder_address         CHAR(42)              # 持有地址
  holder_kind            VARCHAR(16)           # 这个持有地址是谁：USER = 普通用户钱包；CURVE = 曲线合约；POOL_MANAGER = Uniswap 池；FACTORY / RECEIVER / LOCKER / ROUTER / VAULT = 平台的其它合约。持有者榜给 CURVE 标「Bonding Curve」、其余非 USER 的不展示，资产页只列 USER
  balance                DECIMAL(65,0)
  block_number           BIGINT                # 水位线：只接受 (block_number, log_index) 更新的 Transfer（乱序保护）
  log_index              INT
  updated_at             BIGINT
                                               # UK  (token_address, holder_address)
                                               # IDX (token_address, balance DESC)                持有者榜
                                               # IDX (holder_address)                             资产页余额
```

## 派生

```text
launchpad_v2_position                             # 一个（地址, 币）一行，永不关闭；移动平均成本
  chain_id               BIGINT
  token_address          CHAR(42)
  trader_address         CHAR(42)              # 持有地址
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
                                               # UK  (trader_address, token_address)
                                               # IDX (trader_address, last_trade_at DESC)         持仓页

launchpad_v2_kline_minute                         # 只有有成交的分钟才有行（用户 09-18 定）：桶由成交 handler upsert，没有任何定时任务补空桶
  chain_id               BIGINT
  token_address          CHAR(42)
  period_start           BIGINT                # 桶起点，整分钟，毫秒
  open / high / low / close DECIMAL(36,18)     # 配对资产计，取成交后价 price_quote
  open_block / open_log  BIGINT / INT          # open 来自哪笔成交；迟到的更早一笔替换 open（乱序保护）
  close_block / close_log BIGINT / INT         # close 来自哪笔成交；更晚的才替换 close
  open_usd / high_usd / low_usd / close_usd DECIMAL(20,8)
  volume_quote_curve     DECIMAL(65,0)         # 曲线成交量
  volume_quote_pool      DECIMAL(65,0)         # 池内成交量；分开存，「含不含 DEX」读时定
  volume_usd_curve       DECIMAL(20,8)
  volume_usd_pool        DECIMAL(20,8)
  trade_count            INT
                                               # UK  (token_address, period_start)
                                               # IDX (period_start)                               线三跨币取窗口

launchpad_v2_kline_hour                           # 字段同分钟桶，period_start 取整小时；同样只有有成交的小时才有行；ALL 档读它按跨度合并。不建日桶：日 = 24 个小时桶读时合并

launchpad_v2_protocol_day                         # UTC 日 × 配对资产一行；协议数据页
  chain_id               BIGINT
  day_index              INT                   # floor(区块时间 / 86400)
  quote_asset_address    CHAR(42)              # 配对资产地址
  volume_quote_curve / volume_quote_pool DECIMAL(65,0)
  volume_usd_curve / volume_usd_pool     DECIMAL(20,8)
  trade_count            INT
                                               # UK  (day_index, quote_asset_address)
```

## 口径

```text
launchpad_v2_token                                # 一个发射币一行；列表与搜索只读它

  # ── 链上列：TokenLaunched / 毕业 / 成交 / Transfer handler 写 ──
  chain_id               BIGINT
  token_address          CHAR(42)
  curve_address          CHAR(42)
  creator_address        CHAR(42)              # TokenLaunched.creator；对外仍叫 deployerAddress
  tx_from                CHAR(42)
  quote_asset_address    CHAR(42)              # 零地址 = 原生 ETH
  quote_asset_symbol     VARCHAR(16)           # 配对资产的代号，如 ETH / USDG；按地址从运营名单（admin 的 quoteTokens 配置）取，名单里没有为 NULL
  quote_asset_decimals   TINYINT               # 配对资产的精度（ETH 18、USDG 6），所有配对资产金额换整枚都靠它；按地址从运营名单（admin Redis）取，名单里没有为 NULL，整枚数 / USD 留空并告警
  quote_config_hash      CHAR(66)
  launch_config_id       INT
  curve_fee_bps          SMALLINT UNSIGNED
  creator_tax_bps        SMALLINT UNSIGNED
  tick_spacing           INT
  creator_fee_recipient  CHAR(42)              # 发币时的值，不追更新
  buyback_enabled        TINYINT(1)
  initial_virtual_quote_reserve DECIMAL(65,0)
  graduation_threshold   DECIMAL(65,0)
  total_supply           DECIMAL(65,0)         # 币的总供应（最小单位）；发币时取 Java 常量 LaunchConstants.TOTAL_SUPPLY（10 亿 × 1e18），有人销毁就按 Transfer 消息减；市值 = 价 × 它
  token_decimals         TINYINT               # 发射币的精度，合约固定 18；取 Java 常量 LaunchConstants.TOKEN_DECIMALS
  name                   VARCHAR(128)
  symbol                 VARCHAR(32)
  description            VARCHAR(512)          # 对外 tagline
  logo_uri               VARCHAR(512)          # 对外 imageUri
  social_website / social_twitter / social_telegram / social_discord / social_farcaster / social_story_fun  VARCHAR(255)
  launch_tx_hash         CHAR(66)
  launch_block_number    BIGINT
  launch_log_index       INT
  launched_at            BIGINT                # 发币区块时间；NEWEST / OLDEST 排序键
  curve_closed_at        BIGINT                # 曲线关闭时间（CurveCompleted）
  pool_created_at        BIGINT                # V4PoolGraduated
  rescued_at             BIGINT                # LaunchGraduationRescued
  pool_id                CHAR(66)              # Uniswap v4 poolId，只作标识（前端拼链接、与 Swap 对照）；池的其它信息不存
  swept_quote / swept_token DECIMAL(65,0)      # 曲线关闭时交给毕业流程的配对资产 / 本币数量
  quote_reserve          DECIMAL(65,0)         # 曲线阶段已经募到多少配对资产（最小单位，扣掉手续费后的净额）；毕业进度 = 它 ÷ graduation_threshold；曲线关闭后不再变
  liquidity_quote        DECIMAL(65,0)         # 这个币现在的流动性有多少，以配对资产计（最小单位）：曲线阶段 = quote_reserve × 2（Java 算），毕业后由消息给；乘配对资产美元价就是 liquidity_usd
  price_quote            DECIMAL(36,18)        # 币的最新价：一枚发射币值多少配对资产，来自最近一笔成交
  state_block_number     BIGINT                # set 型链上列的水位线：只接受 (block, log) 更新的事件（乱序保护）
  state_log_index        INT
  last_trade_at          BIGINT                # LAST_TRADE 排序键；只往后推
  trade_count            INT
  cum_volume_quote_curve / cum_volume_quote_pool DECIMAL(65,0)
  holder_count           BIGINT                # 余额大于 0 的地址有多少个，含曲线、池子这些合约；展示时减掉非用户地址

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
                                               # UK  (token_address)
                                               # IDX (curve_address)                              曲线事件认币
                                               # IDX (pool_id)                                    Swap 认币
                                               # IDX (creator_address)                            Launches 页签
                                               # IDX (creator_user_id)                            发行者用户
                                               # IDX (og_key)                                     OG 徽标
                                               # IDX (status, last_trade_at)                      列表：最近买入
                                               # IDX (status, market_cap_usd)                     列表：市值、已毕业分区
                                               # IDX (status, volume_usd_24h)                     列表：成交量
                                               # IDX (status, launched_at)                        列表：最新 / 最早

launchpad_v2_coin_price                           # 配对资产美元价历史；线一每分钟追加；priceAt 与线二都读它
  asset_address          CHAR(42)              # 原生币用全零地址
  symbol                 VARCHAR(16)
  price_usd              DECIMAL(20,8)         # 股票代币已乘 currentMultiplier
  source                 VARCHAR(32)           # PriceSource.name()
  priced_at              BIGINT                # 取整到分钟
  created_at             BIGINT
                                               # IDX (asset_address, priced_at)                   priceAt / 最新价

launchpad_v2_token_content                        # 币 ↔ 叙事绑定，TokenLaunched handler 写；一币至多一条
  chain_id               BIGINT
  token_address          CHAR(42)              # 代币地址
  content_type           VARCHAR(8)            # DRAMA / VIDEO
  content_id             BIGINT                # drama.id 或 drama_episode.id
  bound_at               BIGINT
  created_at             BIGINT
                                               # UK  (token_address)                              一币至多一条
                                               # IDX (content_type, content_id)                   按内容反查币
```

## 只读别人的表（不在 V1 里）

`user_wallet_address` / `users`（归 user-wallet）：发行者反查与昵称头像；`drama` / `drama_episode`（归 app）：叙事绑定校验与卡片。规则不变。

## 数据量：三档估算

一笔成交平均带出 2.5 条消息（成交 + 1～2 条 Transfer）。`launchpad_v2_chain_event` 每行含 `raw_message` 约 1.5 KB，其余表每行 100～300 B。

| 日成交笔数 | 消息 / 天 | `chain_event` 一年 | `trade` 一年 | 其余表 |
|---|---|---|---|---|
| **1 千**（冷启动） | 2.5 千 | 90 万行 · 1.4 GB | 36 万行 · 0.1 GB | 都在十万行以下 |
| **1 万**（正常） | 2.5 万 | 900 万行 · 14 GB | 365 万行 · 1 GB | `kline_minute` ≤ 365 万行；`balance` 十万级 |
| **10 万**（火爆） | 25 万 | 9 千万行 · 140 GB | 3,650 万行 · 10 GB | `kline_minute` 千万级 |

写入压力不是问题：10 万笔 / 天平均 3 条消息 / 秒，峰值按 50 倍算也就 150 条 / 秒，批量插入一条 SQL 就吃掉了。**问题只有一个：`chain_event` 的 `raw_message`**，它占了全部体积的 90% 以上。

## 库与分区：建议

**不建独立库（用户 09-18 定）。** 前期只有审计表大，体积靠按月分区 + 月度 `DROP PARTITION` 解决，其余表都在千万行以下，放 `mini_drama` 库即可。将来要不要拆，看两个信号：日成交稳定超过 5 万笔，或 `mini_drama` 实例上其他服务的慢查询能对应到 launchpad 的写入高峰。真要拆代价也小：launchpad 读 `users` / `user_wallet_address` / `drama` / `drama_episode` 的四处本来就是应用层单独查、没有 SQL JOIN，整库挪走只改一个 JDBC URL。

**不分表。** 热查询全部带 `token_address` 或 `trader_address` 走索引，千万行级别 MySQL 单表没有压力；分表只会把「按币查」「按人查」两种访问路径拆到两个维度上，得不偿失。

**按月分区，两张表（用户 09-18 定，方案 A：MySQL 原生分区，不引入 Sharding-JDBC）。** 分区是一张逻辑表在 InnoDB 内部切片，对 mybatis-flex 透明；分表是应用层拆多张物理表，要中间件路由、跨表去重与合并，我们不需要。dev / test 是自建 MySQL 8.0，prod 是 AWS 托管（RDS 或 Aurora 待确认），三者都支持原生分区。

| 表 | 分区键 | 保留 | 唯一键要求 |
|---|---|---|---|
| `launchpad_v2_chain_event` | `block_time` 的月份 | 最近 3 个月保留原文；更早的整个分区 `DROP PARTITION`（Envio 可重扫重投） | MySQL 要求分区表的每个唯一索引（含主键）包含分区列：`uk (event_id, block_time)`、`pk (id, block_time)`。`block_time` 排在末尾，不参与查找，纯为满足规则。**不能用 `received_at` 分区**：同一 eventId 重复投递时 `received_at` 不同，唯一键就拦不住重复 |
| `launchpad_v2_trade` | `block_time` 的月份 | 永久 | `uk (tx_hash, log_index, block_time)`、`pk (id, block_time)`，同一笔日志的 `block_time` 固定，去重不受影响 |

其余表不分区。`DROP PARTITION` 是秒级元数据操作，比 `DELETE … WHERE` 清一亿行便宜几个数量级，这是分区的主要收益。

**可选的进一步减肥**：Transfer 是消息的大头、又只用来 set 余额，可以只落审计行不存 `raw_message`（Envio 的 `raw_events` 才是原文），`chain_event` 体积再降一半以上。要不要这么做等第一个月看真实量再定。
