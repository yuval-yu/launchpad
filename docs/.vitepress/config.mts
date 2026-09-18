import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: '发射台后端设计',
  description: 'StoryFun 发射台（自研合约 · Robinhood Chain）后端设计：Envio 扫链 → Kafka → Java 落库',
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
      { text: '扫链层', items: [
        { text: '3 · Envio 只做扫链', link: '/envio' },
        { text: '4 · 消息契约', link: '/messages' },
      ] },
      { text: '服务层', items: [
        { text: '5 · Java 改造点', link: '/java' },
        { text: '6 · 定价与 USD', link: '/pricing' },
        { text: '7 · 数据表', link: '/tables' },
      ] },
      { text: '对照', items: [
        { text: '8 · 前端接口', link: '/frontend' },
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
