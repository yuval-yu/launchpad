---
title: 10 · 按「拿到 ABI」切分，第一周的活现在就能开
---

# 按「拿到 ABI」切分，第一周的活现在就能开

## 落地顺序

1. **把事件清单和八个问题发出去，同时在 dev 起一套 Envio** [第 9 页](/events)今天就能发。并行用 `envio init` 起一个最小 indexer，docker 起 indexer + Postgres + Hasura，对主网索引现有 PONS 工厂的发币事件（HyperSync）、对测试网用 QuickNode RPC 同上。验 `contractRegister` 同区块首买、`getWhere` 同区块可见性（SnipeTaxCharged → CurveBuy、Swap → HookFeeCollected → Transfer 三组同 tx 配对）、`@index` 建出来的索引、回填速度、Effect 读 MySQL、Hasura 游标查询。**这步不需要我们的 ABI**。
2. **线一先跑起来** 从备份分支挑回币安价源，按 profile 定 dev / test 的做法；新接 Robinhood 股票 API 与 multiplier 同步；`launchpad_coin_price` 补分钟行 / 小时行；admin 名单加 `isStable` / `priceSource`。它要先于索引层有数据，否则回填出来的 USD 全是 null。
3. **写 Envio 的 schema 与 handler** ABI 到了之后填事件、生成类型，实现[第 4 页](/indexer)的全部 handler 与两个 Effect；主网 / 测试网各配一份 `start_block`。
4. **Token 同步器与线二** 拷 `Token`，线二接管绑定、发行者用户、算现价类 USD。能在业务库里排出一个市场列表就算通。
5. **线三、线四与读接口换源** 详情、K 线、成交、持有者、余额、Activity 改查 Envio 加 Redis 缓存；持仓页与历史持仓两个新接口读 `Position` 与卖出 `Trade`；协议数据页改读 `ProtocolDay`。**前端零改动是硬要求**，换源期间任何响应结构都不许变；`publicName` / `tags` 变 null、上报接口下线要提前告知前端。
6. **补齐毕业、池内成交、资产页两份余额** 已毕业分区、毕业后行情依赖前两条；资产页平台币余额查 Envio 的 `Balance`，配对资产余额改成 RPC `balanceOf`，Blockscout 下线。池内成交是我们现在完全没有的能力。
7. **对链对账** 没有现成实现可比对，对账对象是链本身：每个曲线币 `eth_getBalance(curve)` 对 Σ 买入 − Σ 卖出 − Σ 费用清扫，容差 1%；抽样地址 `balanceOf` 对 `Balance`。**对账脚本切完之后留着**。
8. **test 与 prod 各起一套 Envio，删旧代码与旧表** Postgres 按生产标准配备份与监控。**CMC 整个下线**：客户端、缓存、额度监控、key；Blockscout 客户端；Kafka 消费者与 `pons.event`；`ReceiptDecoder`；[第 7 页](/tables)列的四张表；整点快照；上报写路径与状态机。没上线过、无旧数据，不留兼容分支。**admin Redis 的运营名单保留**，加 `isStable` / `priceSource`。

## 风险

| 风险 | 后果 | 怎么办 |
|---|---|---|
| **自建 Envio 不可用** | 列表停更但可用；详情页明细类缓存过期后变空并标 `stale` | 三个容器接现有监控；「已处理区块落后链头」告警；Redis 缓存兜住短抖动。它是我们自己的进程，恢复手段在自己手里 |
| **Postgres 运维** | 磁盘、备份、连接数出问题拖垮索引 | 按生产标准管，和 MySQL 同等对待；实体表增长可预估：成交与转账是主要增量 |
| **测试网只能走 RPC** | 同步慢、重组检测有漏检的边角、依赖 QuickNode 限流 | 测试网数据量小，可接受；W1 实测速度；生产是主网，不受影响 |
| **成本法进了索引层** | 改成先进先出、改粉尘处理，要重跑索引 | 移动平均是业内通行做法，改的概率低；重跑分钟级 |
| **取价规则进了索引层** | 换价源、改「缺价怎么办」要重跑索引 | Effect 缓存键是（资产，分钟），价格表本身不变时重跑全命中缓存；HyperSync 上重跑是分钟级 |
| **线一停机造成 USD 空洞** | 那段时间的成交与桶 USD 为 null，事后不补 | 线一是最简单的一个 job，加监控 |
| **改 handler 要重跑** | 重新部署并等 Envio 追上 | handler 只放事实、纯加减、固定取价规则；口径全在 Java；事件签名定了就少动 |
| **外部价源不可用** | 对应那类配对资产的币 USD 字段为 null | 与现状一致，接受。币安与 Robinhood 各管一类资产 |
| **链上注册了新配对资产，运营名单还没配价源** | 用它发的币照常收录、金额按配对资产显示，但 USD 全空，市值排序垫底 | 线二对比 `QuoteAssetConfig` 与运营名单，缺价源就告警；补上后下一分钟起有价，历史成交的 USD 不补 |
| **股票代币盘后报价行为不明** | 周末 bid / ask 冻结或缺失 | 上线前观察一个周末；`isTradingHalt` 给 null；必要时改用链上 Chainlink 喂价 |
| **合约升级不通知** | 新签名 handler 收不到，Envio 不报错，新币悄悄不入库 | 「工厂最后一次发币时间」告警 + 对账脚本。仍要约定通知 |
| **QuickNode 抖动** | 资产页配对资产那一份拿不到 | 30 秒缓存、失败给旧值、再没有就该份降级；平台币那一份来自 Envio 不受影响 |
