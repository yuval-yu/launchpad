---
title: 1 · Envio 扫链、Kafka 投递、Java 落库
---

# Envio 扫链、Kafka 投递、Java 落库

发射台合约换成自研，链仍是 **Robinhood Chain**。**Envio 只做扫链工具**：订阅我们合约的事件、解码、补几个「看整笔交易才能定」的字段、发到 Kafka。 **launchpad 里的 Java** 监听消息、落审计、投影成事实表与派生表、算口径与 USD，**读接口全部查 MySQL**。 之前接的是 PONS 这个外部发射台的合约，现在改扫我们自己的合约；随之顶掉外部扫链、CMC、Blockscout、QuickNode 和前端上报；配对资产的美元价是唯一保留的外部数据。

::: info
**前提** · 自研发射台合约源码在 workspace 根 `src/`，事件已逐条对照（[第 9 页](/events)）：metadata 在发币事件里、退款不含在成交额里、成交后价格可由储备推出、配对资产链上注册。币的行情必须自己算，CMC 不认自研曲线合约。
:::

::: info
**硬约束** · 前端零改动。每一条线都对齐到 launchpad 现有的响应契约，凡是现有字段都要有来源；给不出的字段明确写 null，不静默消失。上报接口 `POST /activities` 下线是唯一的前端改动。0x gasless 四个透传接口不在本文范围。
:::

::: info
**收录范围** · 经我们工厂发的币全部收录，只看是不是我们工厂发的。
:::

::: info
**版本** · v6（本版）：Envio 退回扫链工具，实体、Hasura 读路径、handler 里的取价 Effect 全部作废；Java 保留「Kafka → 审计表 → 投影」的代码骨架，表全部从零建，前缀 `launchpad_v2_`（线上数据不要了，旧表不动）。v5.1 及更早只在 git 历史里。
:::

## 数据怎么流、在哪生成

<svg style="max-width:100%;height:auto;display:block;font-size:12px;color:var(--vp-c-text-1)" viewBox="0 0 1180 560" role="img" aria-label="数据流转图：Robinhood 链上事件经 Envio 扫链解码并补字段后发到 Kafka，Java 监听写审计表再投影到事实表与派生表，定时线算口径列，读接口只查 MySQL；配对资产价格由 Java 线一从外部价源取，落价格历史表，成交 handler 按区块时间取价固化 USD。">
<defs>
<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
</marker>
</defs>
<g style="fill:var(--vp-c-text-3);font-size:10.5px;letter-spacing:.08em">
<text x="20" y="24">链与外部源</text>
<text x="250" y="24">ENVIO · 扫链</text>
<text x="500" y="24">KAFKA</text>
<text x="650" y="24">JAVA · LAUNCHPAD</text>
<text x="930" y="24">MYSQL · MINI_DRAMA</text>
</g>

<rect x="20" y="50" width="190" height="50" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="30" y="70" fill="currentColor" style="font-weight:600">配对资产价源</text>
<text x="30" y="88" style="fill:var(--vp-c-text-2);font-size:11px">按资产路由，来源待定</text>
<line x1="210" y1="75" x2="648" y2="75" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<text x="430" y="68" text-anchor="middle" style="fill:var(--vp-c-text-2);font-size:11px">现价，每分钟</text>
<rect x="650" y="50" width="230" height="50" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="660" y="70" fill="currentColor" style="font-weight:600">线一 · 定价</text>
<text x="660" y="88" style="fill:var(--vp-c-text-2);font-size:11px">PriceSource 路由，落分钟行</text>
<line x1="880" y1="75" x2="928" y2="75" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<rect x="930" y="50" width="220" height="50" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="940" y="70" fill="currentColor" style="font-family:var(--vp-font-family-mono);font-size:11.5px;font-weight:500">launchpad_v2_coin_price</text>
<text x="940" y="88" style="fill:var(--vp-c-text-2);font-size:11px">价格历史，唯一价源</text>

<rect x="20" y="160" width="190" height="60" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="30" y="182" fill="currentColor" style="font-weight:600">Robinhood Chain</text>
<text x="30" y="200" style="fill:var(--vp-c-text-2);font-size:11px">自研发射台合约的事件</text>
<line x1="210" y1="190" x2="248" y2="190" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>

<rect x="250" y="130" width="220" height="230" rx="4" style="fill:var(--vp-c-bg-soft);stroke:var(--vp-c-divider)"/>
<text x="262" y="148" style="fill:var(--vp-c-text-3);font-size:10.5px;letter-spacing:.06em">QuickNode RPC · 主网与测试网</text>
<rect x="262" y="160" width="196" height="54" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-brand-1)"/>
<text x="272" y="179" fill="currentColor" style="font-weight:600">handler</text>
<text x="272" y="195" style="fill:var(--vp-c-text-2);font-size:11px">解码 · contractRegister</text>
<text x="272" y="208" style="fill:var(--vp-c-text-2);font-size:11px">补 trader / 储备 / 价格 / 流动性 / 余额</text>
<rect x="262" y="226" width="196" height="40" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="272" y="243" fill="currentColor" style="font-weight:600">最小状态</text>
<text x="272" y="258" style="fill:var(--vp-c-text-2);font-size:11px">curve / poolId → token，两个储备</text>
<rect x="262" y="278" width="196" height="40" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="272" y="295" fill="currentColor" style="font-weight:600">确认深度后发送</text>
<text x="272" y="310" style="fill:var(--vp-c-text-2);font-size:11px">effect：Kafka producer，key = token</text>
<text x="262" y="345" style="fill:var(--vp-c-text-3);font-size:10.5px">不建业务实体、不算 USD、不出 GraphQL</text>

<line x1="470" y1="245" x2="498" y2="245" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<rect x="500" y="215" width="130" height="60" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="510" y="235" fill="currentColor" style="font-family:var(--vp-font-family-mono);font-size:11.5px;font-weight:500">launchpad.chain.events</text>
<text x="510" y="252" style="fill:var(--vp-c-text-2);font-size:11px">分区键 token</text>
<text x="510" y="266" style="fill:var(--vp-c-text-2);font-size:11px">同币有序 · 至少一次</text>
<line x1="630" y1="245" x2="648" y2="245" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>

<rect x="650" y="130" width="230" height="330" rx="4" style="fill:var(--vp-c-bg-soft);stroke:var(--vp-c-divider)"/>
<rect x="660" y="140" width="210" height="44" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="670" y="157" fill="currentColor" style="font-weight:600">监听 · 审计</text>
<text x="670" y="172" style="fill:var(--vp-c-text-2);font-size:11px">批量 insertIfAbsent，eventId 去重</text>
<rect x="660" y="222" width="210" height="60" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-brand-1)"/>
<text x="670" y="240" fill="currentColor" style="font-weight:600">投影 handler</text>
<text x="670" y="255" style="fill:var(--vp-c-text-2);font-size:11px">事实行首插成功 → 推进派生表</text>
<text x="670" y="270" style="fill:var(--vp-c-brand-1);font-size:11px">priceAt(资产, 区块时间) × 数量 = USD</text>
<rect x="660" y="296" width="210" height="44" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="670" y="313" fill="currentColor" style="font-weight:600">线二 · 线三</text>
<text x="670" y="328" style="fill:var(--vp-c-text-2);font-size:11px">现价类 USD、绑定、滚动 24h</text>
<rect x="660" y="354" width="210" height="44" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="670" y="371" fill="currentColor" style="font-weight:600">读接口 REST</text>
<text x="670" y="386" style="fill:var(--vp-c-text-2);font-size:11px">全部查 MySQL，前面先不加缓存</text>
<rect x="660" y="410" width="210" height="40" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="670" y="427" fill="currentColor" style="font-weight:600">重投 · 回放 · 死信</text>
<text x="670" y="442" style="fill:var(--vp-c-text-2);font-size:11px">按 id / 按币 / 按事件 / 全量重建</text>
<line x1="765" y1="184" x2="765" y2="220" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<polyline points="1040,102 1040,118 905,118 905,262 870,262" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>

<line x1="880" y1="162" x2="928" y2="162" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<rect x="930" y="140" width="220" height="44" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="940" y="157" fill="currentColor" style="font-family:var(--vp-font-family-mono);font-size:11.5px;font-weight:500">launchpad_v2_chain_event</text>
<text x="940" y="172" style="fill:var(--vp-c-text-2);font-size:11px">原文 · 状态 · 重放源</text>

<line x1="880" y1="252" x2="928" y2="252" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<rect x="930" y="200" width="220" height="110" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="940" y="218" style="fill:var(--vp-c-text-3);font-size:10.5px;letter-spacing:.06em">事实表</text>
<text x="940" y="235" fill="currentColor" style="font-family:var(--vp-font-family-mono);font-size:11.5px">trade · balance</text>
<text x="940" y="256" style="fill:var(--vp-c-text-3);font-size:10.5px;letter-spacing:.06em">派生表</text>
<text x="940" y="273" fill="currentColor" style="font-family:var(--vp-font-family-mono);font-size:11.5px">position · kline_*</text>
<text x="940" y="290" fill="currentColor" style="font-family:var(--vp-font-family-mono);font-size:11.5px">protocol_day</text>
<text x="1060" y="303" style="fill:var(--vp-c-text-3);font-size:10.5px">按区块时间固化的 USD 在这里</text>

<line x1="880" y1="318" x2="928" y2="340" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<rect x="930" y="326" width="220" height="60" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="940" y="344" fill="currentColor" style="font-family:var(--vp-font-family-mono);font-size:11.5px;font-weight:500">launchpad_v2_token</text>
<text x="940" y="360" style="fill:var(--vp-c-text-2);font-size:11px">链上列 ← handler · 口径列 ← 线二 / 线三</text>
<text x="940" y="376" style="fill:var(--vp-c-text-3);font-size:10.5px">列表排序、搜索、join 平台表</text>
<rect x="930" y="400" width="220" height="36" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="940" y="422" fill="currentColor" style="font-family:var(--vp-font-family-mono);font-size:11.5px;font-weight:500">launchpad_v2_token_content</text>
<polyline points="930,376 918,376 918,383 882,383" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>

<rect x="650" y="490" width="230" height="44" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="660" y="508" fill="currentColor" style="font-weight:600">前端 web-onestory-www</text>
<text x="660" y="524" style="fill:var(--vp-c-text-2);font-size:11px">接口形状不变；不再上报 tx hash</text>
<line x1="765" y1="460" x2="765" y2="488" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>

<g style="font-size:11px">
<line x1="20" y1="540" x2="70" y2="540" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<text x="78" y="544" style="fill:var(--vp-c-text-2)">写入 / 推送</text>
<line x1="170" y1="540" x2="220" y2="540" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>
<text x="228" y="544" style="fill:var(--vp-c-text-2)">读取</text>
</g>
</svg>

::: info 图说
**三条数据生成路径。** ① 链上事件 → Envio 解码、补字段 → Kafka → Java 审计表 → handler 写事实表，并在事实行首次插入成功时推进派生表；成交的 USD 按区块时间从价格历史取，写下就不再变。 ② 外部价源 → Java 线一 → `launchpad_v2_coin_price`，全站唯一价源。 ③ 线二、线三读派生表与价格表，把现价类 USD、绑定、滚动 24h 写回 `launchpad_v2_token`。读接口全部查 MySQL。
:::

## 分层

- **Robinhood Chain**（source of truth · 自研发射台合约）：**我们对合约唯一的要求是「事件要发全」**，见[第 9 页](/events)。
- **Envio**（扫链 · 我们自己部署）：工厂地址写死，curve 与发射币用 `contractRegister` 动态注册。handler 解码事件、用一份**最小内部状态**（curve / poolId → token，两个曲线储备）补上 Java 单看一条消息定不了的字段、把同 tx 的配对事件合并，然后经 effect 发 Kafka。**不建业务实体、不算 USD、不出 GraphQL**，见[第 3 页](/envio)。
- **Kafka**（`launchpad.chain.events`）：分区键 token，同币有序、至少一次投递。消息格式见[第 4 页](/messages)。
- **Java**（launchpad · 消费、投影、口径、读接口）：「监听 → 审计表 → 投影」骨架 + 九个 handler；十二张新表（审计 / 事实 / 派生 / 口径 / 状态）；线一定价、线二币视图、线三滚动窗口；读接口全查 MySQL。改造点见[第 5 页](/java)。
- **MySQL**（`mini_drama` 库 · `launchpad_v2_` 前缀）：审计表、币表、事实表、派生表、价格表、绑定表，见[第 7 页](/tables)。
- **前端**：接口形状不变；`POST /activities` 下线。

## 这套分工换来什么

- **Java 侧改动最小。** 消费管线、审计表、handler 注册、重投、回放全是现成的，新来源 = 新 topic + 新 handler
- **所有数据在一个库里。** 列表、详情、K 线、成交、持有者、资产页都是普通 SQL，没有跨库 join、没有第二套查询语言
- **口径全在 Java。** 改任何口径只重算 MySQL，Envio 不重跑；Envio 只在合约事件签名变时才改
- **审计与重放留在自己手里。** 审计表就是重放源：按 id、按币、按事件类型、全量重建四种入口
- **Java 的外部依赖只剩价源。** CMC、Blockscout 下线；QuickNode 只有 Envio 用，Java 不碰

## 保留的外部依赖

| 依赖 | 用途 | 挂了会怎样 |
|---|---|---|
| **QuickNode RPC** | Envio 的区块数据源，主网与测试网都是（不用 HyperSync） | Envio 停更，消息停止；恢复后从断点续。Java 不调 RPC |
| **配对资产价源**（[第 6 页](/pricing)） | ETH 系、稳定币、股票代币的美元价 | 对应那类配对的币 USD 字段为 null |

Envio 停了：消息停止，列表与详情停在最后一条消息的状态，前端仍可用；恢复后从断点继续，不丢事件。

## 三条纪律

- **所有链上语义在 Envio**：解码、合约数学、ERC20 余额、交易者穿透、同 tx 配对。Java 里没有 ABI、不解析事件、不读合约；RPC 只剩查用户配对资产余额那一处（[第 2 页](/facts)的例外）；它的输出是消息，不是表
- **派生表只由事实行首次插入成功推进。** 持仓、K 线桶、协议日是累加型，由成交事实行推进；**余额、总供应、持有人数同理，由转账事实行推进**（09-21 改：扫链不再给变动后的绝对值，余额由 Java 累加，为此新增第十二张表 `launchpad_v2_transfer`）。这条是回放和重投不重复计数的唯一保证
- **价格历史表是 USD 固化的前提。** 成交的 USD 按区块时间取「已知的最近一行」，不是当前价，也不因为旧就给 null（有价总比没价好）；线一每分钟落行
