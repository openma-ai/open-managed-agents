import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mdx from '@astrojs/mdx';
import { remarkZhDocLinks } from './src/remark-zh-links.mjs';

// Brand fonts — Geist is bundled by custom.css; Source Serif 4 (display
// headings) and JetBrains Mono (code) are loaded via Starlight's head[] config rather
// than @import inside customCss so the CSS waterfall (custom.css → @import
// fonts.googleapis.com → fonts.gstatic.com) collapses into parallel
// requests. print-onload makes the stylesheet non-blocking; the
// <noscript> fallback keeps it working without JS. Same pattern web uses.
const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap';

export default defineConfig({
  site: 'https://docs.openma.ai',
  markdown: {
    remarkPlugins: [remarkZhDocLinks],
  },
  integrations: [
    starlight({
      title: 'openma',
      description: 'Open-source alternative to Claude Managed Agents — self-host Claude agents on Cloudflare or Docker.',
      // Root keeps the existing English URLs. `zh-cn` is Starlight's locale
      // directory; the language picker switches `/…` and `/zh-cn/…`.
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        'zh-cn': { label: '简体中文', lang: 'zh-CN' },
      },
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      components: {
        // Adds a default og:image and page-aware JSON-LD on top of
        // Starlight's canonical/OG/hreflang output.
        Head: './src/components/Head.astro',
      },
      head: [
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://fonts.gstatic.com',
            crossorigin: '',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: FONT_HREF,
            media: 'print',
            onload: "this.media='all'",
          },
        },
        {
          tag: 'noscript',
          content: `<link rel="stylesheet" href="${FONT_HREF}">`,
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/openma-ai/open-managed-agents',
        },
      ],
      editLink: {
        baseUrl:
          'https://github.com/openma-ai/open-managed-agents/edit/main/apps/docs/',
      },
      lastUpdated: true,
      pagination: true,
      sidebar: [
        {
          label: 'Get Started',
          translations: { 'zh-CN': '开始使用' },
          items: [
            { label: 'Welcome', translations: { 'zh-CN': '欢迎' }, link: '/' },
            { label: 'Quickstart', translations: { 'zh-CN': '快速开始' }, slug: 'quickstart' },
            { label: 'Concepts', translations: { 'zh-CN': '概念' }, slug: 'concepts' },
            { label: 'Sandboxes', translations: { 'zh-CN': '沙箱' }, slug: 'sandboxes' },
          ],
        },
        {
          label: 'Use the Console',
          translations: { 'zh-CN': '使用控制台' },
          items: [
            { label: 'Getting Started', translations: { 'zh-CN': '入门' }, slug: 'console/getting-started' },
            {
              label: 'Connect Integrations',
              translations: { 'zh-CN': '连接集成' },
              slug: 'console/integrations',
            },
          ],
        },
        {
          label: 'Build with the API',
          translations: { 'zh-CN': '用 API 构建' },
          items: [
            { label: 'REST API', translations: { 'zh-CN': 'REST API' }, slug: 'build/api' },
            { label: 'CLI & SDK', translations: { 'zh-CN': 'CLI 与 SDK' }, slug: 'build/cli-sdk' },
            { label: 'Skills & Tools', translations: { 'zh-CN': '技能与工具' }, slug: 'build/skills-and-tools' },
            { label: 'Vault & MCP', translations: { 'zh-CN': 'Vault 与 MCP' }, slug: 'build/vault-and-mcp' },
            { label: 'Custom Integrations', translations: { 'zh-CN': '自定义集成' }, slug: 'build/integrations' },
          ],
        },
        {
          label: 'Self-host',
          translations: { 'zh-CN': '自托管' },
          items: [
            { label: 'Overview', translations: { 'zh-CN': '概述' }, slug: 'self-host/overview' },
            { label: 'Node + Docker (no Cloudflare)', translations: { 'zh-CN': 'Node + Docker（不用 Cloudflare）' }, slug: 'self-host/node-docker' },
            { label: 'Deploy on Fly.io', translations: { 'zh-CN': '部署到 Fly.io' }, slug: 'self-host/fly' },
            { label: 'Managed Runtime Host', translations: { 'zh-CN': '托管运行时宿主' }, slug: 'self-host/managed-runtime-host' },
            { label: 'Sandbox & persistence', translations: { 'zh-CN': '沙箱与持久化' }, slug: 'self-host/sandbox-persistence' },
            {
              label: 'Sandbox providers',
              translations: { 'zh-CN': '沙箱提供商' },
              collapsed: true,
              items: [
                { label: 'E2B', slug: 'self-host/sandbox/e2b' },
                { label: 'Daytona', slug: 'self-host/sandbox/daytona' },
                { label: 'Modal', slug: 'self-host/sandbox/modal' },
                { label: 'Sprites', slug: 'self-host/sandbox/sprites' },
                { label: 'Vercel', slug: 'self-host/sandbox/vercel' },
                { label: 'Blaxel', slug: 'self-host/sandbox/blaxel' },
                { label: 'Cloudflare', slug: 'self-host/sandbox/cloudflare' },
                { label: 'Docker', slug: 'self-host/sandbox/docker' },
                { label: 'GKE', slug: 'self-host/sandbox/gke' },
              ],
            },
            {
              label: 'Execution backend contract',
              translations: { 'zh-CN': '执行后端接入契约' },
              slug: 'self-host/sandbox-backend',
            },
            { label: 'Deploy on Cloudflare', translations: { 'zh-CN': '部署到 Cloudflare' }, slug: 'self-host/deploy' },
            { label: 'OAuth Apps', translations: { 'zh-CN': 'OAuth 应用' }, slug: 'self-host/oauth-apps' },
            { label: 'Operations', translations: { 'zh-CN': '运维' }, slug: 'self-host/operations' },
          ],
        },
        {
          label: 'Reference',
          translations: { 'zh-CN': '参考' },
          items: [
            { label: 'Configuration', translations: { 'zh-CN': '配置' }, slug: 'reference/configuration' },
            { label: 'API Endpoints', translations: { 'zh-CN': 'API 端点' }, slug: 'reference/api' },
            { label: 'Glossary', translations: { 'zh-CN': '术语表' }, slug: 'reference/glossary' },
          ],
        },
        {
          label: 'Contribute',
          translations: { 'zh-CN': '贡献' },
          items: [
            { label: 'Contributing', translations: { 'zh-CN': '贡献指南' }, slug: 'contribute' },
            { label: 'State Machines', translations: { 'zh-CN': '状态机' }, slug: 'contribute/state-machines' },
            { label: 'Recovery & Idempotency', translations: { 'zh-CN': '恢复与幂等' }, slug: 'contribute/recovery-and-idempotency' },
          ],
        },
        {
          // ↗ glyph in label is load-bearing: Starlight 0.38.4 doesn't
          // paint an external-link affordance on sidebar entries, so
          // without this prefix the Console link looks identical to
          // internal docs links.
          label: '↗ Console',
          translations: { 'zh-CN': '↗ 控制台' },
          link: 'https://app.openma.ai',
          attrs: { target: '_blank', rel: 'noopener' },
        },
      ],
    }),
    mdx(),
  ],
});
