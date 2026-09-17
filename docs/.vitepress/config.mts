import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: '发射台自建索引层',
  description: 'StoryFun 发射台（自研合约 · Robinhood Chain）后端设计：Envio 自建 + Java + MySQL',
  base: '/launchpad/',
  lastUpdated: true,
  cleanUrls: true,
  themeConfig: {
    outline: { level: [2, 3], label: '本页' },
    sidebar: [
      { text: '设计', items: [
        { text: '1 · 总览', link: '/' },
        { text: '2 · 事实与口径', link: '/facts' },
      ] },
      { text: '索引层', items: [
        { text: '3 · Envio 是什么', link: '/envio' },
        { text: '4 · Envio 负责什么', link: '/indexer' },
      ] },
      { text: '服务层', items: [
        { text: '5 · Java 负责什么', link: '/java' },
        { text: '6 · 定价与 USD', link: '/pricing' },
        { text: '7 · 数据表', link: '/tables' },
      ] },
      { text: '对照', items: [
        { text: '8 · 前端能力', link: '/frontend' },
        { text: '9 · 合约与事件', link: '/events' },
      ] },
      { text: '执行', items: [
        { text: '10 · 落地与风险', link: '/rollout' },
      ] },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/yuval-yu/launchpad' }],
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdatedText: '更新于',
    search: { provider: 'local' },
  },
  markdown: { lineNumbers: false },
})
