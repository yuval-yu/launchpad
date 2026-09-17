---
title: 1 · 发射台自建索引层
---

# 发射台自建索引层

发射台合约换成自研，链仍是 **Robinhood Chain**。**自建的 Envio HyperIndex** 索引我们合约的事件， TypeScript handler 把链上事实、机械派生和**成交时点的 USD** 落进它的 Postgres； **launchpad 里的 Java** 只拷一张币表来做列表，其余明细**请求来了直接查 Envio**。 同时顶掉**扫链（Let's Pod → Kafka）**、**CMC**和**Blockscout**； 配对资产的美元价改用免费的币安公开行情与 Robinhood 股票价格接口，是唯一保留的外部行情。

::: info
**前提** · 自研发射台合约源码已在 workspace 根 `src/`，事件已逐条对照（[第 9 页](/events)）：metadata 在发币事件里、退款不含在成交额里、成交后价格可由事件推出、配对资产链上注册。币的行情必须自己索引，CMC 不认自研曲线合约。
:::

::: info
**硬约束** · 前端零改动。每一条线都对齐到 launchpad 现有的响应契约，凡是现有字段都要有来源；给不出的字段明确写 null，不静默消失。0x gasless 那四个透传接口不在本文范围。
:::

::: info
**收录范围** · 经我们工厂发的币全部收录，只看是不是我们工厂发的，不看其它字段。
:::

::: warning
**TODO（等 ABI 核对后写入）** · ① 第八个实体 `TokenFees`：累计税与费、三路清扫、创作者已领取 / 可领取、收款人、回购开关，给币详情费用区、创作者领取横幅、Launches 费用状态； ② `Trade.kind` 加 `REDEEM`，救援 / 赎回类按卖出规则结盈亏；③ 事件分类规则：有没有让某用户的币或配对资产进出，有则进 Trade / 调 Position，无则只留 raw_events； ④ 用[第 9 页](/events)「空 handler」表里的费用事件（FeesDistributed / PoolFeesSwept / FeeEscrow / BuybackVault）建 `TokenFees` 与 `EscrowAccount`；⑤ **Rescued 终态怎么展示**：曲线关闭后 7 天没建成池、治理把储备释放走的币，隐藏、标「已终止」还是留在已毕业分区，去问合约与产品。已核实：退款不含在 quoteIn 里；合约没有持有人分红，也没有用户赎回路径，②③ 里的 REDEEM 暂无对应事件。
:::

::: info
**版本** · v3 graph-node、v4 Substreams 均作废。v5 定为 Envio；**v5.1（本版）**两处收敛：Envio **自建**在我们的 VPC 里，handler 可以直接读我们的价格历史，成交时点的 USD 在索引层算好； Java 不再逐表拷贝，只拷 `Token`，明细读时直查 Envio。
:::

## 数据怎么流、在哪生成

一张图看全：链上事件从左往右变成 Envio 的实体，配对资产的美元价从上面那条独立的线进来，Java 只拷一张币表，其余读时直查。实线是写入或推送，虚线是读取，带色标的实体里有成交时点固化的 USD。

<svg style="max-width:100%;height:auto;display:block;font-size:12px;color:var(--vp-c-text-1)" viewBox="0 0 1180 800" role="img" aria-label="数据流转图：Robinhood 链上事件经 HyperSync 进入自建 Envio 的 handler，写成 QuoteAssetConfig、Token、Trade、Balance、Position、CandleMinute、CandleHour、CandleDay、ProtocolDay 九个实体，其中 Trade、Candle、ProtocolDay 带成交时点 USD，价格由 handler 通过 Effect 按区块时间读 MySQL 的 launchpad_coin_price；该表由 Java 线一每分钟从币安和 Robinhood 股票 API 取价追加。Java 的 Token 同步器每 2 秒按 updatedAtBlock 拷 Token 到 launchpad_token，线三读小时桶算 24h，线二读 Balance 与 coin_price 最新行算叙事绑定与现价类 USD；读接口只有列表和搜索查 MySQL，详情、K 线、成交、持有者、余额、Activity、协议日直查 Hasura，配对资产余额走 QuickNode RPC 的 balanceOf，最后以不变的 REST 形状给前端。">
<defs>
<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
</marker>
</defs>
<g style="fill:var(--vp-c-text-3);font-size:10.5px;letter-spacing:.08em">
<text x="20" y="24">链与外部源</text>
<text x="250" y="24">ENVIO · 自建</text>
<text x="650" y="24">JAVA · LAUNCHPAD</text>
<text x="930" y="24">MYSQL · MINI_DRAMA</text>
</g>
<rect x="20" y="50" width="190" height="50" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="30" y="70" fill="currentColor" style="font-weight:600">币安公开行情</text>
<text x="30" y="88" style="fill:var(--vp-c-text-2);font-size:11px">Robinhood 股票代币价格 API</text>
<line x1="210" y1="75" x2="648" y2="75" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<text x="430" y="68" text-anchor="middle" style="fill:var(--vp-c-text-2);font-size:11px">现价，每分钟</text>
<rect x="650" y="50" width="230" height="50" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="660" y="70" fill="currentColor" style="font-weight:600">线一 · 定价</text>
<text x="660" y="88" style="fill:var(--vp-c-text-2);font-size:11px">按资产分路由，落分钟行与小时行</text>
<line x1="880" y1="75" x2="928" y2="75" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<text x="904" y="68" text-anchor="middle" style="fill:var(--vp-c-text-2);font-size:10.5px">追加</text>
<rect x="930" y="50" width="220" height="50" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="940" y="70" fill="currentColor" style="font-family:var(--vp-font-family-mono);font-size:11.5px;font-weight:500">launchpad_coin_price</text>
<text x="940" y="88" style="fill:var(--vp-c-text-2);font-size:11px">配对资产美元价历史，唯一价源</text>
<polyline points="580,250 620,250 620,118 1040,118 1040,102" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>
<text x="630" y="112" style="fill:var(--vp-c-brand-1);font-size:11px">Effect pairPriceAt(资产, 分钟)：读区块时间之前最近一行</text>
<rect x="20" y="160" width="190" height="60" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="30" y="182" fill="currentColor" style="font-weight:600">Robinhood Chain</text>
<text x="30" y="200" style="fill:var(--vp-c-text-2);font-size:11px">自研发射台合约的事件</text>
<line x1="210" y1="180" x2="268" y2="180" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<text x="239" y="173" text-anchor="middle" style="fill:var(--vp-c-text-2);font-size:10.5px">日志</text>
<rect x="250" y="130" width="350" height="470" rx="4" style="fill:var(--vp-c-bg-soft);stroke:var(--vp-c-divider)"/>
<text x="262" y="148" style="fill:var(--vp-c-text-3);font-size:10.5px;letter-spacing:.06em">indexer + Postgres + Hasura · VPC 内</text>
<rect x="270" y="160" width="310" height="40" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="425" y="184" text-anchor="middle" fill="currentColor" style="font-size:11.5px">HyperSync（主网）· QuickNode RPC（测试网）</text>
<line x1="425" y1="200" x2="425" y2="218" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<text x="432" y="214" style="fill:var(--vp-c-text-2);font-size:10.5px">按区块推事件</text>
<rect x="270" y="220" width="310" height="60" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-brand-1)"/>
<text x="280" y="239" fill="currentColor" style="font-weight:600">TypeScript handler</text>
<text x="280" y="255" style="fill:var(--vp-c-text-2);font-size:11px">解码 · contractRegister · 余额与累加 · 分桶</text>
<text x="280" y="271" style="fill:var(--vp-c-brand-1);font-size:11px">pairPriceAt × 数量 = 成交时点 USD</text>
<line x1="425" y1="280" x2="425" y2="298" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<text x="432" y="294" style="fill:var(--vp-c-text-2);font-size:10.5px">写实体，重组时自动回滚</text>
<text x="270" y="312" style="fill:var(--vp-c-text-3);font-size:10.5px;letter-spacing:.06em">POSTGRES 实体 · HASURA GRAPHQL</text>
<g style="font-family:var(--vp-font-family-mono);font-size:11.5px">
<rect x="270" y="318" width="310" height="34" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="280" y="339" fill="currentColor">Token</text>
<text x="330" y="339" style="fill:var(--vp-c-text-2);font-family:var(--vp-font-family-base);font-size:11px">链上列 · 累加值 · updatedAtBlock</text>
<rect x="270" y="360" width="310" height="34" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<rect x="270" y="360" width="4" height="34" style="fill:var(--vp-c-brand-1)"/>
<text x="282" y="381" fill="currentColor">Trade</text>
<text x="332" y="381" style="fill:var(--vp-c-text-2);font-family:var(--vp-font-family-base);font-size:11px">amountUsd · trader · 卖出行的 pnl</text>
<rect x="270" y="402" width="310" height="34" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<rect x="270" y="402" width="4" height="34" style="fill:var(--vp-c-brand-1)"/>
<text x="282" y="423" fill="currentColor">Candle 分 / 时 / 日</text>
<text x="418" y="423" style="fill:var(--vp-c-text-2);font-family:var(--vp-font-family-base);font-size:11px">open…closeUsd · volumeUsd</text>
<rect x="270" y="444" width="310" height="34" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<rect x="270" y="444" width="4" height="34" style="fill:var(--vp-c-brand-1)"/>
<text x="282" y="465" fill="currentColor">ProtocolDay</text>
<text x="372" y="465" style="fill:var(--vp-c-text-2);font-family:var(--vp-font-family-base);font-size:11px">volumeUsd（日 × 配对资产）</text>
<rect x="270" y="486" width="310" height="34" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="280" y="507" fill="currentColor">Balance</text>
<text x="340" y="507" style="fill:var(--vp-c-text-2);font-family:var(--vp-font-family-base);font-size:11px">持有者余额 · Position 持仓成本与盈亏</text>
<rect x="270" y="528" width="310" height="34" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="280" y="549" style="fill:var(--vp-c-text-2);font-family:var(--vp-font-family-base);font-size:11px">九个实体 · 没有读者的事件只留 raw_events</text>
</g>
<line x1="580" y1="335" x2="648" y2="335" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>
<line x1="580" y1="419" x2="648" y2="415" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>
<line x1="580" y1="503" x2="648" y2="490" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>
<line x1="600" y1="572" x2="648" y2="572" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>
<rect x="650" y="318" width="230" height="50" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="660" y="337" fill="currentColor" style="font-weight:600">Token 同步器 <tspan style="font-weight:400;fill:var(--vp-c-text-2);font-size:11px">每 2 秒</tspan></text>
<text x="660" y="355" style="fill:var(--vp-c-text-2);font-size:11px">按 updatedAtBlock 拉变过的币，整行覆盖</text>
<rect x="650" y="390" width="230" height="50" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="660" y="409" fill="currentColor" style="font-weight:600">线三 · 24h 窗口 <tspan style="font-weight:400;fill:var(--vp-c-text-2);font-size:11px">每 5 分钟</tspan></text>
<text x="660" y="427" style="fill:var(--vp-c-text-2);font-size:11px">小时桶 volumeUsd 求和，算涨跌</text>
<rect x="650" y="462" width="230" height="50" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="660" y="481" fill="currentColor" style="font-weight:600">线二 · 币视图 <tspan style="font-weight:400;fill:var(--vp-c-text-2);font-size:11px">每分钟</tspan></text>
<text x="660" y="499" style="fill:var(--vp-c-text-2);font-size:11px">绑定 · 发行者用户 · 持有人数 · 现价类 USD</text>
<rect x="650" y="540" width="230" height="64" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-brand-1)"/>
<text x="660" y="558" fill="currentColor" style="font-weight:600">读接口 REST</text>
<text x="660" y="574" style="fill:var(--vp-c-text-2);font-size:11px">列表 · 搜索 ← MySQL</text>
<text x="660" y="590" style="fill:var(--vp-c-text-2);font-size:11px">详情 · K 线 · 成交 · 持有者 · 余额 ← Hasura</text>
<rect x="650" y="704" width="230" height="50" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="660" y="723" fill="currentColor" style="font-weight:600">前端 web-onestory-www</text>
<text x="660" y="741" style="fill:var(--vp-c-text-2);font-size:11px">接口形状不变，零改动</text>
<line x1="880" y1="340" x2="928" y2="340" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<line x1="880" y1="412" x2="928" y2="412" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<line x1="880" y1="472" x2="928" y2="472" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<polyline points="880,486 918,486 918,622 928,622" fill="none" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<polyline points="930,92 905,92 905,500 882,500" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>
<text x="905" y="300" text-anchor="middle" style="fill:var(--vp-c-text-2);font-size:10px">最新行</text>
<polyline points="1040,512 1040,590 882,590" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>
<rect x="930" y="318" width="220" height="194" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="940" y="338" fill="currentColor" style="font-family:var(--vp-font-family-mono);font-size:11.5px;font-weight:500">launchpad_token</text>
<text x="940" y="358" style="fill:var(--vp-c-text-2);font-size:11px">链上列 · 累加列 ← 同步器</text>
<text x="940" y="416" style="fill:var(--vp-c-text-2);font-size:11px">24h 成交额 · 涨跌 ← 线三</text>
<text x="940" y="476" style="fill:var(--vp-c-text-2);font-size:11px">现价 · 市值 · 流动性 · 持有人数 ← 线二</text>
<text x="940" y="500" style="fill:var(--vp-c-text-3);font-size:10.5px">列表排序、搜索、join 平台表都在这里</text>
<rect x="930" y="604" width="220" height="36" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="940" y="626" fill="currentColor" style="font-family:var(--vp-font-family-mono);font-size:11.5px;font-weight:500">launchpad_token_content</text>
<rect x="20" y="640" width="190" height="50" rx="3" style="fill:var(--vp-c-bg);stroke:var(--vp-c-border)"/>
<text x="30" y="660" fill="currentColor" style="font-weight:600">QuickNode RPC</text>
<text x="30" y="678" style="fill:var(--vp-c-text-2);font-size:11px">eth_getBalance + balanceOf，配对资产余额</text>
<polyline points="210,665 700,665 700,606" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>
<text x="455" y="658" text-anchor="middle" style="fill:var(--vp-c-text-2);font-size:10.5px">配对资产余额，读时，一个地址几次 call</text>
<line x1="830" y1="604" x2="830" y2="702" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<text x="838" y="656" style="fill:var(--vp-c-text-2);font-size:10.5px">REST</text>
<g style="font-size:11px">
<line x1="20" y1="772" x2="70" y2="772" stroke="currentColor" stroke-width="1.4" marker-end="url(#ar)"/>
<text x="78" y="776" style="fill:var(--vp-c-text-2)">写入 / 推送</text>
<line x1="170" y1="772" x2="220" y2="772" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>
<text x="228" y="776" style="fill:var(--vp-c-text-2)">读取</text>
<rect x="290" y="765" width="4" height="14" style="fill:var(--vp-c-brand-1)"/>
<text x="302" y="776" style="fill:var(--vp-c-text-2)">实体里带成交时点固化的 USD</text>
<text x="520" y="776" style="fill:var(--vp-c-text-3)">Hasura 读路径前有 Redis 短缓存（几秒）；现价类 USD 只在 MySQL</text>
</g>
</svg>

::: info 图说
**四条数据生成路径。** ① 链上事件 → Envio handler → 事实实体与机械派生，Trade / Candle / ProtocolDay 在写入时经 Effect 读价格历史，把成交时点的 USD 一并固化，重组时随实体回滚。 ② 币安与 Robinhood 的现价 → Java 线一 → `launchpad_coin_price`，这是全站唯一的价源，Envio 和 Java 都读它。 ③ Token 实体 → 同步器 → `launchpad_token` 链上列；线三从小时桶算 24h，线二算绑定与现价类 USD，都写回同一张表，列表页只查它。 ④ 读接口：只有列表与搜索查 MySQL，详情及其它明细类直查 Hasura，配对资产余额查 RPC，形状不变地返回给前端。
:::

## 分层

同一件事按层说一遍。关键是「哪些东西在索引层里算、哪些在 Java 里算」，[第 2 页](/facts)讲判据。

- **Robinhood Chain**（source of truth · 自研发射台合约）：我们自己的发射台合约发出事件。**我们对合约唯一的要求是「事件要发全」**，见[第 9 页](/events)。
- **Envio HyperIndex**（自建 · indexer + Postgres + Hasura · VPC 内）：工厂地址写死，curve 与发射币用 `contractRegister` 动态注册。handler 把事件**原样落成事实实体**，维护**机械派生**（余额、累加值、以配对资产计的桶、协议日原始量）， 并**按区块时间读我们的价格历史**给每笔成交和每个桶写上 USD。**重组自动回滚，这些实体一起回退。** 不判业务状态、不认识短剧和用户、不算跟现价走的数。
- **Java**（launchpad 内 · 币表 + 口径 + 现价类 USD）：把 `Token` 实体增量拷进 `launchpad_token`，线二绑叙事、补发行者用户、算现价类 USD（现价、市值、流动性），线三算滚动 24h，线一维护价格历史。 详情、K 线、成交、持有者、余额、Activity、协议日**请求来了直接查 Envio**，前面一层 Redis 短缓存。
- **MySQL**（三张表 + 平台数据）：`launchpad_token`、`launchpad_coin_price`、`launchpad_token_content`，和绑定表、用户表同库，**列表、搜索是普通 SQL**；详情页只从这里取配对资产现价、叙事、发行者用户三样。
- **前端**（web-onestory-www）：接口形状不变，**零改动**。

## 这套分工换来什么

- **跨库 join 不再是问题。** 币表和绑定表、用户表同在 MySQL，列表排序分页搜索是一条 SQL
- **同步代码只剩一张表。** 成交、转账、余额、桶都不拷，游标、确认深度、回滚不同步那些事一并消失
- **USD 在源头就固化好。** 每笔成交、每个桶的 USD 由 handler 按区块时间取价写死，读时不再合并价格；重组时连 USD 一起回滚
- **重组不用自己处理。** Envio 回滚它的实体；Java 只拷 `Token`，按更新区块重拷加每小时活跃币重刷即可
- **历史可回算。** 事实实体存全，口径变了 Java 重算；handler 变了 Envio 从 HyperSync 重跑是分钟级
- **新币秒级可见。** HyperSync 跟着链头走，发射后第一笔成交几秒内就在列表和 K 线上

## 保留的外部依赖

| 依赖 | 用途 | 挂了会怎样 |
|---|---|---|
| **HyperSync** | 主网区块数据源，Envio 自家的，免费档够用要实测 | 超过 20 秒没新块自动切到 QuickNode RPC 兜底 |
| **QuickNode RPC** | 测试网数据源、主网兜底、资产页配对资产余额（原生 ETH 用 `eth_getBalance`，其余用 `balanceOf`） | 测试网停更；资产页配对资产那一份降级，平台币那一份不受影响 |
| **币安公开行情** | ETH / WETH / cbBTC 的美元价，免费无 key。**CMC 彻底下线** | 这几类配对的币 USD 字段为 null |
| **Robinhood 股票代币价格 API** | 股票代币的美元价 | 股票配对的币 USD 字段为 null |

Envio 本身不是外部依赖了，是我们自己运维的三个容器；它停了详情页明细类在缓存过期后变空并标 `stale`，列表页不受影响。

## 三条纪律

- **Envio 只存事实、纯机械的派生、成交时点固化的 USD。** 跟现价走的数（现价、市值、流动性、24h）和叙事绑定全在 Java，改它们不重跑索引。取价规则进了索引层是唯一的例外，改它要重跑，HyperSync 上是分钟级
- **价格历史表是 USD 固化的前提。** handler 取的是「区块时间之前最近一行」，不是当前价；线一每分钟落行，停机窗口的空档给 null，不猜不补
- **MySQL 里的 `launchpad_token` 随时可以按币清空重拷。** 真要对账，对的是 Envio 和链
