---
title: 2 · 什么在 Envio 做，什么在 Java 做
---

# 什么在 Envio 做，什么在 Java 做

::: warning 09-21 变更（本页是最初给扫链的方案，下面两点以[第 4 页](/messages)与[第 11 页](/gap)为准）
- **建池事件认 `LaunchFactory.LaunchGraduated`**，不是 `V4GraduationReceiver.V4PoolGraduated`：扫链订阅的是同一笔交易里的前者并补了 `derived`。
- **余额由 Java 累加**：Transfer 消息不再需要变动后余额、总供应、正余额地址数，只要 `args` 与 `fromKind` / `toKind`；扫链那边的 `Balance` 实体留不留随意。
:::

Envio 的输出是消息，不是表，所以判据只有一条：**Java 单看一条消息定不了、而 Envio 看整笔交易或它自己的内部状态一眼就能定的，由 Envio 补进消息；其余全在 Java。** 代价不对称：进了 Envio 的规则要改就得重跑扫链并重投消息；留在 Java 的规则改了只重算 MySQL。

## 判据表

| Envio · 解码与补字段 | Java · 事实落库、派生、口径、USD |
|---|---|
| 分区键：同一个币的所有事件落同一分区（curve / poolId → token 的映射 Envio 有，Java 也有：`launchpad_v2_token` 存了 `curve_address` 与 `pool_id`） | 这笔算买还是卖、计不计入成交额、含不含税 |
| **交易者是谁**：用整笔收据里本币 Transfer 的净流量穿透路由 / 中继（[第 3 页](/envio)）。Java 单看一条消息看不到整笔 tx，上一版放 Java 就是认不准 v4 买家的原因 | 交易者对应哪个平台用户；Activity 按谁查 |
| 成交后曲线的两个储备与由此推出的价格；每次 Transfer 后双方的余额、总供应、正余额地址数 | 现在值多少美元、市值、24h 量、涨跌：**要乘配对资产的价**，只能 Java 算 |
| 池内 Swap 里本币是 currency0 还是 currency1、方向、两侧金额；费用按 BPS 拆成基础费 / 创作者税 / 反狙击税 | 持有人数剔哪些合约、发行者持仓占比 |
| 发币事件原文：metadata、socials（含 `storyFun`）、creator | 发行者对应哪个平台用户、`storyFun`（`drama_{id}` / `video_{id}`）绑到哪部剧、OG 是谁 |
| 每条消息带确认深度之后才发 | 「曲线一关就算毕业」这类状态名 |

## Java 里不许出现的东西

**launchpad 里不做任何链上数据处理**：不扫链、不解析合约、没有任何和合约挂钩的接口。下面这些一旦出现，说明消息缺字段，去补消息，不在 Java 里补逻辑。

| 不许有 | 现在放哪 |
|---|---|
| RPC 客户端、web3j、`eth_*` 调用、区块浏览器客户端 | Envio 的 Effect。**唯一例外**：配对资产余额接口，见表下 |
| 合约常量 | 例外：`LaunchDefaults` 里编译死的三个全局常量（总供应 10 亿枚〔库里存整枚〕、精度 18、铸给曲线的初始余额）放 Java 的 `LaunchConstants`，不走消息；配对资产的精度 / 代号 / 图标由运营在 admin Redis 维护；阈值、初始储备是按币快照，随发币消息来 |
| ABI、事件签名、topic 常量、日志解码 | Envio 的 handler |
| 合约数学：曲线定价公式、`sqrtPriceX96` 换算、currency0 / currency1 判方向、费用按 BPS 拆分 | Envio 算好放进 `derived`。**例外（用户 09-20 定）：曲线阶段的币价由 Java 算**——扫链给的是成交后的两个定价储备（`payload.curve.virtualQuoteReserve` / `virtualTokenReserve`），Java 做一次除法再按两侧精度换算；公式只写在一处。储备的累加、虚拟储备的构成仍然全在 Envio，Java 不知道曲线参数 |
| ERC20 语义：余额累加、销毁减供应、持有人数 | ~~Envio 维护内部 `Balance`，消息给变动后的绝对值，Java 只 set~~ **09-21 改：Java 从转账事实行累加**（首插才原子加减），Envio 只给 `from` / `to` / `value` 与地址类别。这是「链上语义归扫链」唯一让出来的一块，原因是扫链那边算太慢；Java 仍然不查链 |
| 交易者穿透、同 tx 事件配对 | Envio |
| 0x 下单透传 | 暂时保留在 launchpad，原样不动；它只转发前端请求，不读链、不解析合约 |

Java 里剩下的全是**对自家表的算术与业务口径**：USD 乘法、成交表求和、K 线分桶、持仓成本、叙事绑定、发行者反查、状态名。

::: warning 唯一的例外：配对资产余额（09-19 定）
`GET /assets/balances/quote-tokens` 要的是用户钱包里 ETH / USDG / 股票代币的余额，发射台事件覆盖不到，Envio 也不该为此去订全链的 Transfer。这个接口**保留，由后端查链**，边界圈死在五条里：

1. 只服务这一个接口，别的代码不许引用这个客户端。
2. 只有两种调用：`eth_getBalance` 与名单内 ERC-20 的 `balanceOf`（链上有 Multicall 就合并成一次）。不解析事件、不读收据、不碰发射台合约。
3. RPC 端点沿用 admin 名单的 `chainlinks[chain].rpc.http`，不另配。
4. 每个地址 30 秒缓存；查链失败给缓存里的旧值；旧值也没有，该行余额与 `syncedAt` 给 null，不报错。
5. 平台发的币的余额仍然只读 `launchpad_v2_balance`，不走这条路。
:::

## 一个币的四个链上状态

| 合约状态 | 发生了什么 | 触发事件 | Java 里的 `status` |
|---|---|---|---|
| `Trading` | 曲线上正常买卖 | TokenLaunched | CURVE |
| `Swept` | 曲线卖完，`closeCurve` 把储备收进工厂。曲线关闭、池子还没建 | CurveCompleted（同 tx 的 LaunchSwept 等价，扫链给的是前者） | **GRADUATED**（现行口径「曲线一关就算毕业」） |
| `Graduated` | `graduate` 把储备交给 Receiver，Uniswap v4 池建好、流动性永久锁定，此后在池里交易 | V4PoolGraduated | GRADUATED |
| `Rescued` | 卡在 Swept 超过 7 天没建成池，治理把储备释放走。永远不会有池 | LaunchGraduationRescued | RESCUED，展示口径待产品定 |

Java 存三个时间戳 `curve_closed_at` / `pool_created_at` / `rescued_at`，`status` 由它们推出；产品改口径只改那一处。

## USD 的两类，都在 Java

| 类型 | 例子 | 谁算 | 取哪个价 |
|---|---|---|---|
| **成交时点固化** | 每笔成交的 `amount_usd`、每个桶的 `*_usd`、协议日的成交额 | 成交 handler，写入时 | `priceAt(配对资产, 区块时间)`：价格历史表里 ≤ 区块时间的最近一行，不看多旧（有价总比没价好）；写下就不再变，回放结果确定 |
| **跟着现价走** | 现价、市值、流动性、24h 成交额、24h 涨跌 | 线二 / 线三，定时 | 价格历史表最新一行，不看多旧；ETH 一动全表都变 |

## 为什么口径不能进 Envio

::: warning
这几个月真实改过的口径：滚动 24h 改成昨天这个完整 UTC 日、市值口径从 ETH 改回 USD、持有者榜剔除合约的判据、OG 徽标怎么算、日视图基线取哪天、成交额缺失时给 null 还是回落。**全是口径，链上事实一次都没变过。** 这些都在 Java，改了只重算表；Envio 只在合约事件签名变的时候才动。
:::

## Envio 里明确不做的

| 不做 | 交给谁 |
|---|---|
| 任何 USD | Java：成交 handler 固化、线二 / 线三现价 |
| 状态名（GRADUATED 等） | Java 线二由三个时间戳推 |
| 剔除协议合约后的持有人数、发行者持仓占比 | Java 由余额表按 `holder_kind` 算；地址是什么 kind 由 Envio 给 |
| 滚动 24h | Java 线三 |
| 叙事绑定、OG、发行者是哪个平台用户 | Java 线二 |
| 持仓成本与盈亏 | Java 成交 handler 维护 `launchpad_v2_position` |
| 配对资产的余额 | 不索引：全链 WETH / USDG 持有者是发射台事件的几十倍；资产页那一份怎么来见[第 10 页](/rollout)待定项 |
| 费用 / 回购 / 治理类事件 | 只留 `raw_events`，本期不发消息 |
