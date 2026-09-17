# launchpad

StoryFun 发射台（自研合约 · Robinhood Chain）后端设计文档，VitePress 站点。

- 在线：https://yuval-yu.github.io/launchpad/
- 源文件：`docs/*.md`，一页一个文件，侧栏在 `docs/.vitepress/config.mts`
- 本地预览：`npm install && npm run docs:dev`
- 推送到 `main` 后由 GitHub Actions 构建并发布到 Pages

| 文件 | 页 |
|---|---|
| `docs/index.md` | 1 · 总览（含数据流转图） |
| `docs/facts.md` | 2 · 事实与口径 |
| `docs/envio.md` | 3 · Envio 是什么 |
| `docs/indexer.md` | 4 · Envio 负责什么（schema、handler、Position 规则） |
| `docs/java.md` | 5 · Java 负责什么 |
| `docs/pricing.md` | 6 · 定价与 USD |
| `docs/tables.md` | 7 · 数据表 |
| `docs/frontend.md` | 8 · 前端能力 |
| `docs/events.md` | 9 · 合约与事件 |
| `docs/rollout.md` | 10 · 落地与风险 |
