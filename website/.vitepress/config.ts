import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitepress'

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  base: '/inlaycms/',
  cleanUrls: true,
  lang: 'en-US',
  title: 'Inlay',
  description: 'A code-first CMS for content sites.',
  srcExclude: ['snippets/**', 'README.md'],
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/inlaycms/favicon.svg' }]],
  markdown: {
    theme: 'github-dark',
  },
  vite: {
    // Vite reads `target` from the repo's root tsconfig.json (ES2024), which its esbuild doesn't know.
    esbuild: { tsconfigRaw: { compilerOptions: { target: 'ES2022' } } },
  },
  themeConfig: {
    logo: { light: '/logo.svg', dark: '/logo-dark.svg' },
    siteTitle: 'inlay',
    nav: [
      { text: 'Docs', link: '/docs/quickstart', activeMatch: '^/docs/' },
      { text: 'Why Inlay', link: '/why' },
      { text: `v${version}`, link: 'https://github.com/donstephan/inlaycms/blob/main/CHANGELOG.md' },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/donstephan/inlaycms' }],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/donstephan/inlaycms/edit/main/website/:path',
      text: 'Edit this page on GitHub',
    },
    outline: { level: [2, 3], label: 'On this page' },
    footer: { message: `MIT licensed · Inlay ${version}` },
    sidebar: {
      '/docs/': [
        {
          text: 'Get started',
          items: [
            { text: 'Overview', link: '/docs/' },
            { text: 'Quickstart', link: '/docs/quickstart' },
            { text: 'Without Node: the Docker image', link: '/docs/docker' },
            { text: 'Why Inlay', link: '/why' },
          ],
        },
        {
          text: 'Guides',
          items: [
            { text: 'Content model', link: '/docs/guides/content-model' },
            { text: 'Rich text', link: '/docs/guides/rich-text' },
            { text: 'Shipped content', link: '/docs/guides/shipped-content' },
            { text: 'Releases and hosting', link: '/docs/guides/releases' },
            { text: 'Testing your site', link: '/docs/guides/testing' },
            { text: 'Connect your assistant', link: '/docs/guides/assistant' },
            { text: 'Admin', link: '/docs/guides/admin' },
            { text: 'Search and sharing', link: '/docs/guides/seo' },
            { text: 'Backups, export and restore', link: '/docs/guides/backups' },
            { text: 'Redirects', link: '/docs/guides/redirects' },
            { text: 'Integrations and consent', link: '/docs/guides/integrations' },
            { text: 'Security', link: '/docs/guides/security' },
            { text: 'Behind a proxy or CDN', link: '/docs/guides/proxy-cdn' },
            { text: 'Site password', link: '/docs/guides/site-password' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'CLI', link: '/docs/reference/cli' },
            { text: 'Config', link: '/docs/reference/config' },
            { text: 'Field types', link: '/docs/reference/fields' },
            { text: 'Environment variables', link: '/docs/reference/environment' },
          ],
        },
      ],
    },
  },
})
