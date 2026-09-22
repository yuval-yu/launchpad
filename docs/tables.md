---
title: 7 · 从零建表：十三张
---

# 从零建表：十三张

线上数据不要了，按新方案从零设计，不看旧结构、不留兼容列。全部在 `mini_drama` 库，**表名前缀 `launchpad_v2_`**（用户 09-19 定，与上一版的 `launchpad_*` 区分，两套表可以并存）；**只有一个 migration `V2__launchpad_v2_schema.sql`**，只建新表。旧 `launchpad_*` 表不在这份脚本里，**一律不动**，删不删以后再定。

约定：**数量与金额一律存整枚数 `DECIMAL(36,18)`**（用户 09-20 定，取代原来的「最小单位 `DECIMAL(65,0)`」）——1 ETH 存 `1`、200 USDG 存 `200`、10 亿总供应存 `1000000000`。消息里的 uint256 由 Java 在 handler 取字段时按精度换一次（发射币固定 18 位，配对资产取币行的 `quote_asset_decimals`；只移小数点、不舍入），之后全程整枚，所以价、美元金额、盈亏与按最小单位算逐位相同；**审计表里的消息原文仍是最小单位，消息契约不变**。对外接口里承诺是最小单位的那几个字段读时还原（见[第 8 页](/frontend)）。运营名单里的配对资产精度不得超过 18（不校验，超出的小数位会被列截掉）；**每枚币的价格（无论配对资产计还是美元计）一律 `DECIMAL(50,30)`**——10 亿供应的币价量级是 1e-15 ETH，18 位小数只剩三四位有效数字，8 位小数直接成 0（09-19 审）；整笔金额类（成交额、市值、流动性、成交量的 USD）`DECIMAL(20,8)`；配对资产自身的美元价 `DECIMAL(20,8)`；地址小写 `CHAR(42)`、哈希 / bytes32 小写 `CHAR(66)`、`event_id`，**这些列一律 `CHARACTER SET ascii COLLATE ascii_bin`**（内容永远是 ASCII，utf8mb4 下索引按 4 倍宽度算，改后索引缩到四分之一、比较不走大小写折叠）；时间毫秒 UTC `BIGINT`；每张表 `id BIGINT UNSIGNED AUTO_INCREMENT` 主键、`InnoDB` + `utf8mb4_unicode_ci`、每列带 `COMMENT`。命名跟合约走：合约叫 `quoteAsset`，表里就叫 `quote_asset_*`（对外 DTO 的 `pairAsset` 等字段名不变，映射在 Java）。只接一条链，`chain_id` 列保留但不做多链逻辑：消息里 chainId 与配置不符的在解析层就进死信，进不了任何表；**`chain_id` 不进任何索引和唯一键**（用户 09-18 定，单值列放索引首位没有选择性，只撑长索引）；唯一的例外是总共只有一行的 `launchpad_v2_indexer_state`，它的 `UK (chain_id)` 就是「一条链一行」这条约束本身。

四类表：**审计**（消息原文与状态，重放源）、**事实**（一条日志一行，唯一键幂等：成交、转账）、**派生**（只由事实行首次插入成功推进；**余额 09-21 起归这类**——扫链不再给变动后的绝对值，由 Java 从转账事实行累加）、**口径**（handler 与定时线写、读接口读）。

## 审计

```text
launchpad_v2_chain_event                          # 一条消息一行；唯一键 event_id；重放源
  event_id               VARCHAR(160)          # v1:{chainId}:{blockHash}:{logIndex}:{removed}
  event_name             VARCHAR(64)           # ABI 事件名
  chain_id               BIGINT
  block_number           BIGINT
  block_hash             CHAR(66)
  log_index              INT
  tx_hash                CHAR(66)
  tx_from                CHAR(42)
  block_time             BIGINT                # 毫秒；消息必带
  contract_address       CHAR(42)              # payload.address
  token_address          CHAR(42)              # 这条事件属于哪个发射币，给按币回放用
  raw_message            LONGTEXT              # 原文，重跑投影只读这里；本期全留着，不清理
  status                 VARCHAR(16)           # RECEIVED / PROJECTED / SKIPPED / FAILED / WAITING_TOKEN（币还没到，不计次数，TokenLaunched 到了按币重投）
  attempts               INT
  error                  TEXT
  kafka_key              VARCHAR(66)           # 消息的分区键（应 = token 地址），排障核对
  kafka_partition        INT
  kafka_offset           BIGINT
  received_at            BIGINT
  processed_at           BIGINT
                                               # PK  (id)
                                               # UK  (event_id)                                   去重键：同一条消息重复投递多少次都只有一行
                                               # IDX (block_number, log_index)                    全量重建、按事件名回放：按链上顺序翻页（event_name 不建索引，运维接口回表过滤）
                                               # IDX (token_address, block_number, log_index)     按币回放；发币后唤醒等币的消息（status 回表过滤）
                                               # IDX (status, processed_at)                       重投任务捞 FAILED；按状态计数的指标
                                               # IDX (tx_hash)                                    排障：拿着交易哈希找审计行，代码里没有按它查的路径
                                               # 不分区（用户 09-20 定，见「库与分区」）
```

## 事实

```text
launchpad_v2_trade                                # 一笔成交一行；只插入不更新（盈亏在插入前按持仓算好）
  chain_id               BIGINT
  tx_hash                CHAR(66)
  log_index              INT                   # 这条成交日志在区块里的序号；和 tx_hash 一起唯一标识一笔成交
  token_address          CHAR(42)              # 成交的是哪个发射币
  quote_asset_address    CHAR(42)              # 这个币的配对资产；协议日按它分组、按资产对账都要，不用 join 币表
  venue                  VARCHAR(8)            # 在哪成交：CURVE = 曲线阶段，POOL = 毕业后的 Uniswap 池
  side                   VARCHAR(4)            # BUY = 用户拿配对资产买币，SELL = 用户卖币换回配对资产
  trader_address         CHAR(42)              # 真正买卖的那个人的钱包地址：曲线成交 = 收币 / 卖币的地址（消息给了穿透结果就用穿透结果）；池内成交由消息给，偶尔认不出来为 NULL
  counterparty_address   CHAR(42)              # 交易的另一方：买入时是发起调用的地址（经路由时是路由），卖出时是收款地址，池内是路由
  tx_from                CHAR(42)              # 这笔交易链上的发起人；用 gasless 时是中继地址，所以只作备查
  pool_id                CHAR(66)              # 池内成交才有：在哪个 Uniswap 池成交的
  token_amount           DECIMAL(36,18)        # 成交了多少枚发射币（整枚）
  quote_amount           DECIMAL(36,18)        # 用户实际付出（买）或实际收到（卖）的配对资产数量（整枚，比如 1.5 ETH 或 200 USDG），含手续费。**这是成交额**
  net_quote_amount       DECIMAL(36,18)        # 去掉手续费后真正进出曲线储备的配对资产数量（整枚）；算这笔的均价用它。买入取进储备的净额，卖出取离开储备的毛额；池内成交没有这一项，为空
  fee_amount             DECIMAL(36,18)        # 这笔一共扣了多少手续费（配对资产整枚）；本期不拆分不展示，只存档
  avg_price_quote        DECIMAL(50,30)        # 这笔的成交均价：每枚发射币花了多少配对资产 = net_quote_amount ÷ token_amount，不含手续费；只用来展示这一笔。持仓成本与盈亏不用它，用实付 / 实收（quote_amount、amount_usd）：买完立刻卖，手续费造成的亏损要体现出来
  price_quote            DECIMAL(50,30)        # 这笔成交完成后币的最新价：一枚发射币值多少配对资产；K 线的点用它
  quote_usd_price        DECIMAL(20,8)         # 成交那一刻一枚配对资产值多少美元（取价格历史表里区块时间之前最近的一条）；从未有过价才 NULL
  amount_usd             DECIMAL(20,8)         # 这笔成交折成美元是多少 = quote_amount × quote_usd_price
  cost_quote_released    DECIMAL(36,18)        # 卖出才有：这次卖掉的币当初是花多少配对资产买的（按移动平均成本算），用来算盈亏
  cost_usd_released      DECIMAL(20,8)         # 同上，美元口径
  pnl_quote              DECIMAL(36,18)        # 卖出才有：这次卖赚了或亏了多少配对资产 = 实收 − 当初成本
  pnl_usd                DECIMAL(20,8)         # 同上，美元口径
  pnl_pct                DECIMAL(12,4)         # 同上，百分比：赚 / 亏了成本的百分之几。只有一列，跟配对资产那一套走；释放成本为 0（币全是转入来的）时为空；超出列宽时封顶
  block_number           BIGINT                # 成交在哪个区块
  block_time             BIGINT                # 成交时间（区块时间，毫秒）
  created_at             BIGINT                # 这行写进库的时间
                                               # PK  (id)
                                               # UK  (tx_hash, log_index)                         一条链上日志一行
                                               # IDX (token_address, block_time)                  成交页签（游标 (block_time, id)）、线三 24h 窗口
                                               # IDX (trader_address, block_time)                 Activity、已实现盈亏历史
                                               # IDX (trader_address, token_address, block_number, log_index)   迟到成交触发的持仓重算：取这一对的全部成交、按链上顺序，不用文件排序
                                               # 两条时间索引不显式写 id：InnoDB 二级索引的叶子自带主键列，(token_address, block_time) 物理上就是 (…, block_time, id)，翻页游标由它覆盖
                                               # 不分区

launchpad_v2_transfer                             # 09-21 新增（第十二张）。一条发射币 Transfer 日志一行；只插入不更新。
                                                  #   余额改由 Java 累加，而累加不幂等（重复投递、四种回放、投影事务提交后状态回写前崩溃的重投都会让同一条再过一遍 handler），
                                                  #   所以每条 Transfer 先落这一行，只有首插成功才推进余额 / 总供应 / 持有人数。野池成交、钱包互转天然覆盖：它们只表现为 Transfer
  chain_id               BIGINT
  token_address          CHAR(42)              # 哪个发射币
  from_address           CHAR(42)              # 转出地址；全零 = 铸币（发币那一笔扫链不发，正常遇不到）
  to_address             CHAR(42)              # 转入地址；全零 = 销毁
  amount                 DECIMAL(36,18)        # 转了多少（整枚）。留着 from / to / amount 而不是只留去重键：一条 SQL 就能验「某地址的转账净额 = 余额表那一行」
  block_number / log_index BIGINT / INT
  tx_hash                CHAR(66)
  block_time             BIGINT                # 区块时间，毫秒
  created_at             BIGINT
                                               # PK  (id)
                                               # UK  (tx_hash, log_index)                         一条链上日志一行
                                               # 不另建二级索引：只用来挡重复与对账，排障按币 / 按交易查走审计表的索引。消息量的大头，会是最大的一张表
```

## 派生

```text
launchpad_v2_balance                              # 一个（币, 地址）一行；余额 = 这个地址全部转账事实行的净额。09-21 起是派生表（原先是「消息给的绝对值 set + 水位线」）
  chain_id               BIGINT
  token_address          CHAR(42)
  holder_address         CHAR(42)
  holder_kind            VARCHAR(16)           # USER / CURVE / POOL_MANAGER / FACTORY / RECEIVER / LOCKER / ROUTER / VAULT，取消息里的 fromKind / toKind，只在建行时写（同一地址的类别不会变）
  balance                DECIMAL(36,18)        # 只在转账事实行首插成功时原子加减（INSERT … ON DUPLICATE KEY UPDATE balance = balance ± ?）。没有水位线：累加型的列不能丢弃迟到的消息。
                                               #   加减可交换，所以乱序、补发不影响最终值；中途可能短暂为负（卖出那条先到），不校验，读侧一律只取 balance > 0
  verified               TINYINT(1)            # 这行余额与链上 balanceOf 核对过没有：每次 Transfer 加减置 0，余额校正任务核对（不一致就改成链上的值）后置 1（09-21，工单 39）
  updated_at             BIGINT
                                               # UK  (token_address, holder_address)
                                               # IDX (token_address, holder_kind, balance DESC)   持有者榜
                                               # IDX (holder_address)                             资产页平台币余额、持仓
                                               # IDX (verified, updated_at)                       余额校正任务捞「还没核对、且已经静下来」的行
                                               # 曲线那一行由发币 handler insertIfAbsent（余额 = 总供应，铸币的 Transfer 扫链不发）；回放发币消息不会把累加出来的余额抹回去
                                               # 没有自愈：扫链漏发一条 Transfer，那两个地址一直错到补发为止（补发安全，事实表去重）。靠余额校正任务发现并改回来（09-21，默认关、只在 prod 开）：改成链上的值，不另记调整量——漏的那条补到时会重新标记，下一批再改回来

launchpad_v2_position                             # 一个（地址, 币）一行，永不关闭；移动平均成本
  chain_id               BIGINT
  token_address          CHAR(42)
  trader_address         CHAR(42)              # 持有地址
  qty_traded             DECIMAL(36,18)        # 由成交推出的持有数量：买入加、卖出减，减到 0 为止（卖的币是转入 / 空投来的会超卖，不出现负数），所以它不一定等于 bought_qty − sold_qty
  cost_quote             DECIMAL(36,18)        # 剩余成本，配对资产计。成本与所得一律取成交行的实付 / 实收（含费税），不用不含费的均价。
                                               #   卖出释放的成本 = 剩余成本 × 卖出量 ÷ 卖出前数量；卖光那次直接结转全部剩余成本，归零不留尾数。
                                               #   某一笔缺某个口径的金额（配对资产不在名单 → 没有整枚数；资产从未有过价 → 没有美元数）：买入按当时的均价并入，不稀释均价；
                                               #   卖出照常释放成本，但这一笔该口径的盈亏留空、不计入已实现盈亏。清仓后这一行留着（全零），粉尘过滤由读接口做
  cost_usd               DECIMAL(20,8)
  bought_qty / sold_qty  DECIMAL(36,18)
  bought_quote / sold_quote DECIMAL(36,18)
  bought_usd / sold_usd  DECIMAL(20,8)
  realized_pnl_quote     DECIMAL(36,18)
  realized_pnl_usd       DECIMAL(20,8)
  buy_count / sell_count INT
  first_trade_at / last_trade_at BIGINT
  applied_block / applied_log BIGINT / INT     # 最后一笔按顺序应用的成交；更早的成交迟到 → 重算这一对
  updated_at             BIGINT
                                               # UK  (trader_address, token_address)
                                               # IDX (trader_address, last_trade_at DESC)         持仓页

launchpad_v2_kline_minute                         # 只有有成交的分钟才有行（用户 09-18 定）：桶由成交 handler upsert，没有任何定时任务补空桶
  chain_id               BIGINT
  token_address          CHAR(42)
  period_start           BIGINT                # 桶起点，整分钟，毫秒
  open / high / low / close DECIMAL(50,30)     # 配对资产计，取成交后价 price_quote
  open_block / open_log  BIGINT / INT          # open 来自哪笔成交；迟到的更早一笔替换 open（乱序保护）
  close_block / close_log BIGINT / INT         # close 来自哪笔成交；更晚的才替换 close
  open_usd / high_usd / low_usd / close_usd DECIMAL(50,30)   # 一枚币的美元价，量级可到 1e-11，8 位小数存不下。用每笔成交自己固化的美元价，不用现价。
                                               #   开 / 收严格跟着开 / 收那一笔：那一笔没有美元价就是空，不借别的成交的价（借了结果就取决于到达顺序）；
                                               #   高 / 低取桶内「有美元价的那些成交」的极值。所以同一根里可能 open_usd 为空而 high_usd 有值，读侧要能吃 null
  volume_quote_curve     DECIMAL(36,18)        # 曲线成交量 = 桶内各笔成交额之和（买 grossQuoteIn / 卖 netQuoteOut，与协议日、币行累计同一个数）
  volume_quote_pool      DECIMAL(36,18)        # 池内成交量；分开存，「含不含 DEX」读时定
  volume_usd_curve       DECIMAL(20,8)         # 缺美元价的成交按 0 计（列 NOT NULL）
  volume_usd_pool        DECIMAL(20,8)
  trade_count            INT                   # 量与笔数只在成交行首插成功时加
  updated_at             BIGINT
                                               # UK  (token_address, period_start)

launchpad_v2_kline_hour                           # 字段同分钟桶，period_start 取整小时；同样只有有成交的小时才有行；ALL 档读它按跨度合并。不建日桶：日 = 24 个小时桶读时合并

launchpad_v2_protocol_day                         # UTC 日 × 配对资产一行；协议数据页
  chain_id               BIGINT
  day_index              INT                   # 第几个 UTC 日 = floor(区块时间毫秒 / 86400000)，与各表的 block_time 同单位
  quote_asset_address    CHAR(42)              # 配对资产地址
  volume_quote_curve / volume_quote_pool DECIMAL(36,18)
  volume_usd_curve / volume_usd_pool     DECIMAL(20,8)
  trade_count            INT
  updated_at             BIGINT
                                               # UK  (day_index, quote_asset_address)
```

## 口径

```text
launchpad_v2_token                                # 一个发射币一行；列表与搜索只读它

  # ── 链上列：TokenLaunched / 毕业 / 成交 / Transfer handler 写 ──
  chain_id               BIGINT
  token_address          CHAR(42)
  curve_address          CHAR(42)              # 曲线合约地址，展示与排查用；不建索引，曲线消息自带 token，不按它反查
  creator_address        CHAR(42)              # TokenLaunched.creator；对外仍叫 deployerAddress
  tx_from                CHAR(42)
  quote_asset_address    CHAR(42)              # 零地址 = 原生 ETH
  quote_asset_symbol     VARCHAR(16)           # 配对资产的代号，如 ETH / USDG；按地址从名单表 launchpad_v2_quote_asset 取
  quote_asset_decimals   TINYINT NOT NULL      # 配对资产的精度（ETH 18、USDG 6），消息里的配对资产数量都靠它换成整枚再入库；按地址从名单表 launchpad_v2_quote_asset 取。**一定有**：名单里没有这个配对资产 → 发币消息直接失败（审计行 FAILED），线一下一轮把它同步进名单后自动重投
  quote_config_hash      CHAR(66)
  launch_config_id       INT UNSIGNED
  curve_fee_bps          SMALLINT UNSIGNED
  creator_tax_bps        SMALLINT UNSIGNED
  tick_spacing           INT
  creator_fee_recipient  CHAR(42)              # 发币时的值，不追更新
  buyback_enabled        TINYINT(1)
  initial_virtual_quote_reserve DECIMAL(36,18)
  graduation_threshold   DECIMAL(36,18)
  total_supply           DECIMAL(36,18)        # 币的总供应（整枚）；发币时取 Java 常量 LaunchConstants.TOTAL_SUPPLY（10 亿），销毁（转入零地址）的转账事实行首插成功时原子扣减；市值 = 价 × 它
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
  pool_created_at        BIGINT                # LaunchGraduated 的区块时间（09-21 改：原 V4PoolGraduated）
  rescued_at             BIGINT                # LaunchGraduationRescued
  pool_id                CHAR(66)              # Uniswap v4 poolId，只作标识（前端拼链接）；不建索引，Swap 消息自带 token，不按它反查
  swept_quote / swept_token DECIMAL(36,18)     # 曲线关闭时交给毕业流程的配对资产 / 本币数量
  quote_reserve          DECIMAL(36,18)        # 曲线阶段已经募到多少配对资产（整枚，扣掉手续费后的净额）；毕业进度 = 它 ÷ graduation_threshold；曲线关闭后不再变。列是 NOT NULL DEFAULT 0：「还没成交过」和「净募集为 0」都是 0，有意如此（同组的价与流动性在没成交过时是空）
  liquidity_quote        DECIMAL(36,18)        # 这个币现在的流动性有多少，以配对资产计（整枚）：曲线阶段 = quote_reserve × 2（Java 算），毕业后由消息给；乘配对资产美元价就是 liquidity_usd
  price_quote            DECIMAL(50,30)        # 币的最新价：一枚发射币值多少配对资产，来自最近一笔成交
  trade_state_block / trade_state_log BIGINT / INT   # 成交类列（price_quote / quote_reserve / liquidity_quote）的水位线：只接受更新的事件（乱序保护）
  last_trade_at          BIGINT                # LAST_TRADE 排序键；只往后推
  trade_count            INT
  cum_volume_quote_curve / cum_volume_quote_pool DECIMAL(36,18)  # 累计成交量，配对资产计
  cum_volume_usd         DECIMAL(20,8)         # 累计成交额（美元）= Σ 每笔 amount_usd，成交行首插成功时累加；**VOLUME 排序键**（用户 09-19 定：按总量排，不按 24h）
  holder_count           INT                   # 持有人数：余额大于 0 的**用户**地址（holder_kind = USER）有多少个，不含曲线、池子这些合约（09-21 改：这个数现在是 Java 自己算的，直接算成要展示的数）。用户余额跨过 0 时原子加减一

  # ── 口径列：线二写（每分钟） ──
  status                 VARCHAR(16)           # CURVE / GRADUATED / RESCUED，由三个时间戳推
  graduated_at           BIGINT                # = curve_closed_at
  creator_user_id        BIGINT                # 可空；空 = 卡片只显示地址。对外 deployerUser
  og_key                 VARCHAR(160)          # OG 徽标的分组键，不是「是不是 OG」的标记。
                                               #   生成时去掉的「空白」按 Unicode 算（含全角空格、NBSP）；不做全角→半角折叠，「ＬＯＸ」与「LOX」不同组。
                                               #   名称 128 + 分隔符 + 代号 32 最长 161，超出列宽按字符截到 160（不劈开代理对），写不进去不该让整个币收不进来。
                                               #   写入：TokenLaunched 一到就无条件算 = 去空白小写(name) + "/" + 去空白小写(symbol)，
                                               #        如「Lox ley / LOX」与「loxley / lox」都是 loxley/lox；name 或 symbol 为空则留 NULL（不知道名字谈不上同名首发）。
                                               #        不看有没有同名币、不看先后，之后不改。
                                               #   判定：读列表时现算，不存表。取这一页的 og_key 集合，查每个 key 下 (launch_block_number, launch_log_index) 最小的币，
                                               #        命中的打 og = true。全新名字的币自己就是 OG；后来的同名仿盘 key 相同但发得晚，不打标。
                                               #   来源 CRD 4.1「同名同代号首发，忽略大小写与空格」，现有 util/OgKey 与 MarketListService 的规则原样保留
  price_usd              DECIMAL(50,30)        # price_quote × 配对资产现价
  market_cap_usd         DECIMAL(20,8)         # price_usd × total_supply；MARKET_CAP 与已毕业分区排序键
  liquidity_usd          DECIMAL(20,8)         # liquidity_quote × 配对资产价
  creator_holding_pct    DECIMAL(9,4)          # balance(creator) ÷ total_supply；对外 deployerHoldingPct

  # ── 口径列：线三写（每分钟） ──
  volume_usd_24h         DECIMAL(20,8)         # 滚动 24h Σ amount_usd；只给卡片 / 详情展示，不作排序；没成交置 0
  price_change_24h       DECIMAL(12,4)

  created_at / updated_at BIGINT
                                               # UK  (token_address)
                                               # IDX (creator_address)                            Launches 页签
                                               # IDX (creator_user_id)                            发行者用户
                                               # IDX (og_key)                                     OG 判定：WHERE og_key IN (这页的 key) ORDER BY launch_block_number, launch_log_index，一页一次查询
                                               # IDX (status, last_trade_at)                      列表：最近买入
                                               # IDX (status, market_cap_usd)                     列表：市值、已毕业分区
                                               # IDX (status, cum_volume_usd)                     列表：成交量（累计）
                                               # IDX (status, launched_at)                        列表：最新 / 最早

launchpad_v2_coin_price                           # 配对资产美元价历史；线一每分钟追加；priceAt 与线二都读它
  asset_address          CHAR(42)              # 原生币用全零地址
  symbol                 VARCHAR(16)
  price_usd              DECIMAL(20,8)         # 平台配对资产接口给的美元现价，8 位小数舍入
  source                 VARCHAR(32)           # STORYFUN（09-22 起）；更早的行可能是 FIXED_1 / COINBASE / ROBINHOOD
  priced_at              BIGINT                # 取整到分钟
  created_at             BIGINT
                                               # UK  (asset_address, priced_at)                   同一资产同一分钟只有一行，INSERT IGNORE 天然幂等；priceAt / 最新价也走它

launchpad_v2_quote_asset                          # 09-22 新增（第十三张）。配对资产名单：线一每分钟从平台配对资产接口同步，只增改不删；发币 handler 按地址取精度 / 代号
  asset_address          CHAR(42)              # 主键；小写，原生币用全零地址（本库唯一不用自增 id 的表）
  symbol                 VARCHAR(16)           # 照接口原样，不改大小写
  name                   VARCHAR(128)          # 可空
  decimals               INT
  logo                   VARCHAR(512)          # 可空
  sort_order             INT                   # 在接口返回里的位置，名单与余额接口按它排；消失的资产保留最后一次的值
  created_at             BIGINT
  updated_at             BIGINT                # 内容真的变了才动；每分钟同步但没变时不动

launchpad_v2_indexer_state                        # 消费水位：本服务消费到的最大区块，一条链一行。消费管线每批消息处理完单调推进一次（09-21 改：原设计由扫链的 Heartbeat 写，Heartbeat 已去掉）
  chain_id               BIGINT
  processed_block        BIGINT                # 消费到的最大区块号（扫链至少处理到了这里）；只增不减
  processed_block_time   BIGINT                # 那个区块的时间，毫秒；资产页余额与持仓的 syncedAt 取它。市场安静时停在最后一条消息的区块上；多分区时是各分区的最大值
  updated_at             BIGINT
                                               # UK  (chain_id)

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

**拆表信号。** `launchpad_v2_token` 是宽表，线二 / 线三每分钟改的热列（`price_usd` `market_cap_usd` `liquidity_usd` `volume_usd_24h` `price_change_24h`）里，`market_cap_usd` 上挂着列表排序索引（成交量排序改按累计值后，那条索引只在有成交时才动）。先靠「只写真变了的行」（[第 5 页](/java)定时线）压写入量；币数到十万、或线二一轮跑不完一分钟时，把这六列连同四条排序索引挪到 `launchpad_v2_token_stats`（一币一行），币表只剩静态与链上状态列。代价是列表查询多一次回表，所以没到那个量不拆。

**不建独立库（用户 09-18 定）。** 前期只有审计表大（本期不清理，见下），其余表都在千万行以下，放 `mini_drama` 库即可。将来要不要拆，看两个信号：日成交稳定超过 5 万笔，或 `mini_drama` 实例上其他服务的慢查询能对应到 launchpad 的写入高峰。真要拆代价也小：launchpad 读 `users` / `user_wallet_address` / `drama` / `drama_episode` 的四处本来就是应用层单独查、没有 SQL JOIN，整库挪走只改一个 JDBC URL。

**不分表。** 热查询全部带 `token_address` 或 `trader_address` 走索引，千万行级别 MySQL 单表没有压力；分表只会把「按币查」「按人查」两种访问路径拆到两个维度上，得不偿失。

**本期不分区、不清理（用户 09-20 定，推翻 09-18 的「两张表按月分区」）。** `launchpad_v2_chain_event` 与 `launchpad_v2_trade` 原来按 `block_time` 做月 RANGE 分区，
唯一的实际收益是审计表可以用 `DROP PARTITION` 便宜地清掉三个月前的原文；代价是 MySQL 要求分区表的每个唯一索引（含主键）都带分区列 ——
主键变成 `(id, block_time)`、唯一键末尾硬挂一个不参与查找的 `block_time`（同一 `eventId` 两次投递的区块时间不一致时还拦不住重复），
外加一个每天扩分区、删分区的维护任务。现在的数据量用不上它：两张表都回到普通表，主键 `(id)`、唯一键就是业务键，审计表的原文**全留着**
（它是所有回放的源），分区维护任务整个删掉。**数据量真大了再定分区 / 归档方案，这里不预留、不预写。**

**可选的进一步减肥**：Transfer 是消息的大头、又只用来 set 余额，可以只落审计行不存 `raw_message`（Envio 的 `raw_events` 才是原文），`chain_event` 体积再降一半以上。要不要这么做等第一个月看真实量再定。
