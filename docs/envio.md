---
title: 3 · HyperIndex 跑 handler，HyperSync 供数据，Hasura 出接口
---

# HyperIndex 跑 handler，HyperSync 供数据，Hasura 出接口

只讲和我们相关的部分。一句话：**我们写一份 `config.yaml`、一份 `schema.graphql` 和一组 TypeScript handler， indexer 从 HyperSync 拉区块、跑 handler、把实体写进 Postgres，再通过 Hasura 给出 GraphQL**。三个进程都在我们自己的 VPC 里。

## 三个组件

| 组件 | 是什么 | 对我们意味着 |
|---|---|---|
| **HyperSync** | Envio 自家的区块数据层，按合约地址和事件签名直接取日志，比 RPC 快一到两个数量级，无限速 | **Robinhood 主网 4663 在支持列表里**；测试网 46630 不在，测试网走 RPC。这是唯一仍在 Envio 那边的东西 |
| **HyperIndex** | 索引框架：配置声明链、合约、事件，schema 声明实体，handler 用 TypeScript 写；自动处理动态合约、重组回滚、批量读写 | 我们写这三样，indexer 容器由我们跑 |
| **Hasura** | 实体表上的 GraphQL 引擎：`where`、`order_by`、`limit`、关系查询、聚合 | Java 读时直查它；自建所以聚合可用，也可以给 Postgres 开只读账号 |

## 我们会用到的能力

- **动态合约。** `contractRegister` 在发币事件里把 curve 和 token 地址加进监听，**同一区块内该合约更早的事件也会补上**。发币 tx 里的首买认得出来
- **重组回滚。** 默认开启，实体自动回退到规范链状态；`max_reorg_depth` 默认 200 块。用 HyperSync 时检测有保证，纯 RPC 数据源有漏检的边角
- **数据源组合。** 一条链可以配多个数据源，HyperSync 主、RPC `fallback`，主源 20 秒没新块自动切换；也可以纯 RPC，分 `sync` 与 `realtime` 两类端点，有批量大小与退避参数
- **预加载。** V3 起自动开启：同一批事件要读的实体先一次取回；**handler 会被执行两遍**，第一遍只收集读取，所以外部调用必须走 Effect API，裸调会跑两次
- **Effect API。** handler 里做外部调用的正规入口：`createEffect` 声明输入输出，自带批处理、限速、结果缓存（`cache: true` 落库，重跑直接命中）。**结果不随重组回滚**，所以只用来取「输入定了输出就定」的东西：某资产某分钟的价、某 ERC20 的 `symbol()`。metadata 在发币事件里，不用取 URI
- **字段选择。** `field_selection` 声明要交易的 `from` 和 `hash`，事件里就带 `txFrom`
- **系统表。** `raw_events` 可开可关，开着就是原始日志审计；`dynamic_contracts` 记注册过的地址；链同步状态表给出已处理到的区块

## 自建要跑什么

| 进程 | 说明 | 运维要点 |
|---|---|---|
| **indexer** | 官方镜像，装我们的 config / schema / handler；连 HyperSync 或 RPC，写 Postgres | 单实例，不要起两个；有 Prometheus 指标端点，接现有监控；**能访问 MySQL 或 Redis 读价格历史** |
| **Postgres** | 实体表由 Envio 按 schema 生成，另有回滚用的历史表与系统表 | 按生产标准管：备份、连接数、磁盘。Java 只读账号只查实体表 |
| **Hasura** | 官方镜像，指向同一个 Postgres，Envio 启动时自动追踪实体表 | 只在内网暴露，admin secret 收好；Java 走内网调它 |

官方给 docker 样例并注明「不覆盖全部基础设施需求」，意思是 Postgres 要自己管。dev / test / prod 各一套，dev 与 test 可以共用 Postgres 实例分库。
