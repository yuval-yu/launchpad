---
title: 2 · 什么在 Envio 做，什么在 Java 做
---

# 什么在 Envio 做，什么在 Java 做

Envio 的输出是消息，不是表，所以判据只有一条：**Java 单看一条消息定不了、而 Envio 看整笔交易或它自己的内部状态一眼就能定的，由 Envio 补进消息；其余全在 Java。** 代价不对称：进了 Envio 的规则要改就得重跑扫链并重投消息；留在 Java 的规则改了只重算 MySQL。

## 判据表

| Envio · 解码与补字段 | Java · 事实落库、派生、口径、USD |
|---|---|
| 曲线发出的日志属于哪个 token（`curve → token`）、PoolManager 的 Swap 属于哪个 token（`poolId → token`） | 这笔算买还是卖、计不计入成交额、含不含税 |
| **交易者是谁**：用整笔收据里本币 Transfer 的净流量穿透路由 / 中继（[第 3 页](/envio)）。Java 单看一条消息看不到整笔 tx，上一版放 Java 就是认不准 v4 买家的原因 | 交易者对应哪个平台用户；Activity 按谁查 |
| 同 tx 的配对事件合并：`SnipeTaxCharged` 并进 `CurveBuy`，`HookFeeCollected` 并进 `Swap` | 费用怎么拆、怎么展示 |
| 成交后曲线的两个储备与由此推出的价格（handler 里累加两个数就有） | 现在值多少美元、市值、24h 量、涨跌：**要乘配对资产的价**，只能 Java 算 |
| 池内 Swap 里本币是 currency0 还是 currency1、方向、两侧金额 | 持有人数剔哪些合约、发行者持仓占比 |
| 发币事件原文：metadata、socials（含 `storyFun`）、creator | 发行者对应哪个平台用户、`storyFun` 路径绑到哪部剧、OG 是谁 |
| 每条消息带确认深度之后才发 | 「曲线一关就算毕业」这类状态名 |

## 一个币的四个链上状态

| 合约状态 | 发生了什么 | 触发事件 | Java 里的 `status` |
|---|---|---|---|
| `Trading` | 曲线上正常买卖 | TokenLaunched | CURVE |
| `Swept` | 曲线卖完，`closeCurve` 把储备收进工厂。曲线关闭、池子还没建 | LaunchSwept | **GRADUATED**（现行口径「曲线一关就算毕业」） |
| `Graduated` | `graduate` 把储备交给 Receiver，Uniswap v4 池建好、流动性永久锁定，此后在池里交易 | V4PoolGraduated | GRADUATED |
| `Rescued` | 卡在 Swept 超过 7 天没建成池，治理把储备释放走。永远不会有池 | LaunchGraduationRescued | RESCUED，展示口径待产品定 |

Java 存三个时间戳 `curve_closed_at` / `pool_created_at` / `rescued_at`，`status` 由它们推出；产品改口径只改那一处。

## USD 的两类，都在 Java

| 类型 | 例子 | 谁算 | 取哪个价 |
|---|---|---|---|
| **成交时点固化** | 每笔成交的 `amount_usd`、每个桶的 `*_usd`、协议日的成交额 | 成交 handler，写入时 | `priceAt(配对资产, 区块时间)`：价格历史表里 ≤ 区块时间的最近一行；写下就不再变，回放结果确定 |
| **跟着现价走** | 现价、市值、流动性、24h 成交额、24h 涨跌 | 线二 / 线三，定时 | 价格历史表最新一行；ETH 一动全表都变 |

## 为什么口径不能进 Envio

::: warning
这几个月真实改过的口径：滚动 24h 改成昨天这个完整 UTC 日、市值口径从 ETH 改回 USD、持有者榜剔除合约的判据、OG 徽标怎么算、日视图基线取哪天、成交额缺失时给 null 还是回落。**全是口径，链上事实一次都没变过。** 这些都在 Java，改了只重算表；Envio 只在合约事件签名变的时候才动。
:::

## Envio 里明确不做的

| 不做 | 交给谁 |
|---|---|
| 任何 USD | Java：成交 handler 固化、线二 / 线三现价 |
| 状态名（GRADUATED 等） | Java 线二由三个时间戳推 |
| 持有人数、发行者持仓占比 | Java 由余额表算 |
| 滚动 24h | Java 线三 |
| 叙事绑定、OG、发行者是哪个平台用户 | Java 线二 |
| 持仓成本与盈亏 | Java 成交 handler 维护 `launchpad_position` |
| 配对资产的余额 | 不索引：全链 WETH / USDG 持有者是发射台事件的几十倍；资产页那一份怎么来见[第 10 页](/rollout)待定项 |
| 费用 / 回购 / 治理类事件 | 只留 `raw_events`，本期不发消息 |
