---
title: 10 · 五个阶段、待拍板、风险
---

# 五个阶段、待拍板、风险

::: warning 09-21 变更（本页是最初给扫链的方案，下面两点以[第 4 页](/messages)与[第 11 页](/gap)为准）
- **建池事件认 `LaunchFactory.LaunchGraduated`**，不是 `V4GraduationReceiver.V4PoolGraduated`：扫链订阅的是同一笔交易里的前者并补了 `derived`。
- **余额由 Java 累加**：Transfer 消息不再需要变动后余额、总供应、正余额地址数，只要 `args` 与 `fromKind` / `toKind`；扫链那边的 `Balance` 实体留不留随意。
:::

## 落地顺序

契约先行，删除最后；每个阶段能单独编译、部署、验收。P1 与 P2 可并行。

1. **P0 契约定稿。** 把[第 4 页](/messages)发给写 Envio 的同事，对齐信封、九种事件的 `derived`、分区键、确认深度。在测试网跑出样例：TokenLaunched / CurveBuy / CurveSell / CurveCompleted / V4PoolGraduated / Swap / Transfer 各一条，存进 `src/test/resources/storyfun/*.json`。**出口**：样例进仓库，双方签认。
2. **P1 消费管线改造（与业务无关）。** 死信 topic 与回灌接口；批量消费 + 分区并行；审计表加 `token_address` / `tx_from`、改索引（不分区，用户 09-20 定）；按币 / 按事件 / 全量重建三种回放；micrometer 指标与 lag 告警。**出口**：用 P0 的样例消息在 dev 跑通；1 万条 Transfer 的消费耗时有数。
3. **P2 handler 与十一张表。** 新 topic、九个 handler；按[第 7 页](/tables)从零建十二张 `launchpad_v2_*` 表（旧表不动）；`PriceSource` 接口 + 路由 + `priceAt`；线二、线三。测试网灌数据，与链上 `balanceOf` / curve 储备对账。**出口**：一个币从发射到毕业后 Swap，所有表与链上一致。
4. **P3 读侧切换。** K 线 / 成交 / 持有者 / 资产页 / 协议数据改读自家表；两个新接口；币行行情列改由 handler + 线二 / 线三维护；对比新旧响应。**出口**：test 环境前端全页面走通，响应与 DTO 契约一致。
5. **P4 删除与收尾。** [第 5 页](/java)删除清单（只删代码，旧表不动）；dev / test 库跑 V1 建 v2 表；前端下线 `POST /activities`；`CLAUDE.md` 五节重写。**出口**：仓库里没有 CMC / Blockscout 字样，RPC 只剩查配对资产余额那一处。

## 第一批：扫链已给的四种事件先动工（09-19 定）

扫链目前只发 TokenLaunched / CurveBuy / CurveSell / CurveCompleted，且没有 `derived`。不等，先做不依赖 `derived` 的部分：

| 做 | 不做（等 `derived` 或后面的批次） |
|---|---|
| P1 消费管线全部：批量监听、分区并行、死信、审计表、四种回放 | 价格类的列：`price_quote`、`price_usd`、`market_cap_usd`、`liquidity_*`、成交行的 `price_quote`。**留 NULL**，`derived` 到位后补逻辑，按币回放一遍填上 |
| 十二张 `launchpad_v2_*` 表的 DDL | K 线两张桶表：先不写（桶的开收价就是 `priceQuote`） |
| TokenLaunched、CurveCompleted handler | Swap / Transfer / 毕业三事件 / Heartbeat 的 handler |
| CurveBuy / CurveSell 的成交事实行：数量、金额、`avg_price_quote`、`amount_usd`（`priceAt`）；trader 取 `recipient` / `seller` | `/assets/positions`、`/assets/history` 两个新接口 |
| 持仓表与成本计算（随成交 handler 一起做，含迟到成交重算） | 读接口换表（P3） |
| 线一定价：稳定币锚 1、币安 → Coinbase 主备；Robinhood 源用录制响应做单测 | Robinhood 真实调用 |
| 配对资产余额接口改成只查链 | 删除清单（P4） |

- **分支**：`mini-drama-launchpad` 从 `dev` 拉 `feat/v6-envio-kafka`。**不部署 dev，不动 test 分支**，dev 库暂不建表。
- **消费组** `auto-offset-reset: earliest`：新消费组第一次启动从 topic 头开始读，不丢上线前已经发出的消息。dev 的 Kafka 配置不用改。
- **验收**：单测全绿；本地 Docker（MySQL / Redis / Kafka）灌扫链文档里的样例消息，四种事件全部 PROJECTED、各表数据正确、价格列为 NULL；再把同一批消息**打乱顺序、抽掉三分之一、之后补发**，对账脚本比对两次的表内容一致。

::: tip 第一批已完成（09-19）
分支 `feat/v6-envio-kafka`（未 push、未部署）：十五张工单全部合入，单测 + 集成测试 589 个全绿；「按序灌一遍」与「打乱 + 抽掉三分之一 + 补发 + 重复投」四个随机种子逐表逐列一致，忽略的只有自增 id 与写入时间；本地 Docker 验收脚本 `scripts/local-acceptance/run.sh` 十三项检查全部通过（四种事件 PROJECTED、多发的两种 SKIPPED、价格类列为空、无 K 线桶）。工单与每张的实现备注在 `.scratch/launchpad-v6-envio-kafka/issues/`。
:::

## 已拍板

| 问题 | 结论 |
|---|---|
| 配对资产余额接口 `/assets/balances/quote-tokens` | **保留，后端查链**。是「Java 不做链上处理」的唯一例外，边界见[第 2 页](/facts) |
| 0x gasless 透传 | **暂时保留**，原样不动 |
| 配对资产价源 | 稳定币写死 1；ETH 系币安主、Coinbase 备；股票走 Robinhood。名单只加可选的 `priceSymbol`，见[第 6 页](/pricing) |
| 流通量口径 | 等于总供应（销毁后减少）。聚合站的流通量不含锁仓，我们没有锁仓，两者一致 |

## 待拍板

| 编号 | 问题 | 等谁 | 建议 |
|---|---|---|---|
| Q3 | **确认深度 N** | 扫链 | 由链的最终性定，Robinhood 几乎不重组，取小值 |
| Q4 | **RESCUED 币怎么展示** | 产品 | 数据先收；隐藏 / 标「已终止」/ 留在已毕业分区 |
| Q7 | **dev / test 名单补 `priceSymbol`**（WETH → ETH） | 运营 | 没补之前 WETH 配对的币 USD 为 null，不影响别的 |
| Q8 | **毕业后的币前端默认走哪条路**（直连我们的池 / 0x） | 产品 · 前端 | 默认直连，0x 只用于 gasless 与跨资产；见[第 12 页](/wild-pools) |
| Q9 | **0x 走不走我们的 Hook 池** | 前端 | dev 上询一次价看 `route.fills[].source`；见[第 12 页](/wild-pools) |
| Q10 | **产品要不要 gasless** | 产品 | 决定 0x 能不能完全去掉；见[第 12 页](/wild-pools) |

## 风险

| 风险 | 后果 | 怎么办 |
|---|---|---|
| **野池**（别人拿我们的币另建的 v4 池） | 扫链不过滤：币价 / K 线 / 成交量可被操纵、金额算错；前端走聚合器：活动不完整、收不到基础费与创作者税 | 扫链按 `poolId` 过滤 Swap；币价只认我们的池；下单默认直连（[第 12 页](/wild-pools)） |
| **⌘K 搜索在币多了之后会慢** | 搜索不带 `status`，`(status, 排序列)` 那四条索引对它一条都用不上，每次全表扫 + filesort；`quote_asset_address` 的筛选与 `name` / `symbol` 的 LIKE 也没有索引 | 现在不动（币少时无感）。信号是十万个币：补单列索引（`launched_at` / `cum_volume_usd` / `quote_asset_address`）或改走 ES |
| **Envio 停了** | 消息停止，列表与详情停在最后一条 | 单实例接监控；「已处理区块落后链头」告警；恢复后从断点续，不丢事件 |
| **Envio 重组回滚不撤消息** | 孤块上的事件已落库 | 确认深度后才发（Q3）；Java 的 `removed=true` 分支保留 |
| **消息重复 / 乱序 / 漏发后补发** | 派生表重复计数或被旧值覆盖；持仓算错；成交先于发币到达 | 事实行首插成功才推进累加型；set 型带 (block, log) 水位线；K 线桶记开收锚点；迟到成交触发该对持仓重算；「币还没到」标 WAITING_TOKEN 不限次数（[第 5 页](/java)「乱序与补发」） |
| **写审计表失败** | 消息丢失、无法回放 | 死信 topic + 回灌接口 |
| **审计表增长** | 磁盘 | 本期不分区、不清理（用户 09-20 定）；盯着表体积，数据量大了再定分区 / 归档方案。兜底：Envio 可重扫重投 |
| **线一停机** | 那段时间的成交按停机前最后一个价折算，偏差不补 | 价格比区块时间旧超过一小时打 WARN；线一是最简单的 job，加监控 |
| **外部价源不可用** | 那一轮不落行，对应资产沿用上一个价 | ETH 系币安失败当轮改 Coinbase；价格比区块时间旧超过一小时打 WARN |
| **链上注册了新配对资产，运营名单还没配价源** | 币照常收录、金额按配对资产显示，USD 全空 | 线二发现某币的配对资产在运营名单里没有价源就告警（按币，不再存注册表） |
| **合约升级不通知** | 新签名 Envio 收不到、不报错，新币悄悄不入库 | 「工厂最后一次发币时间」告警；对账脚本；订阅 Deployer 的 `ImplementationUpdated` 当告警源 |
| **配对资产余额接口查链** | RPC 限流或超时，余额页这一块变慢 | 30 秒缓存、失败给旧值、Multicall 合并；只有两种调用，量与在线用户数成正比 |
| **两条链都纯 RPC** | 回填慢；QuickNode 限流或额度不够；动态合约多了 `eth_getLogs` 请求变重 | W1 实测回填与追块的请求量；`sync` / `realtime` 分端点；额度主要是 Envio 的，Java 只剩查配对资产余额 |
