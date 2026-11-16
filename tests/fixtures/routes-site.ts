import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import { defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { defineRoute } from '../../src/core/registry/route.js'
import { escapeHtml, raw } from '../../src/jsx/html.js'
import { navGlobal, webSite } from './web.js'

/** Rendered by routes only: no type uses it. */
export const ThankYou = defineTemplate({
  name: 'thankYou',
  fields: z.object({ title: f.text({ label: 'Title' }), note: f.text({ label: 'Note' }) }),
  render: async ({ fields, page }, ctx) => {
    const nav = await ctx.global(navGlobal)
    const links = (nav?.links ?? []).map((item) => escapeHtml(ctx.link(item.link)?.href ?? ''))
    return raw(
      `<html lang="${escapeHtml(ctx.locale)}"><head><meta charset="utf-8"></head><body>` +
        `<nav>${links.join(' ')}</nav><h1>${escapeHtml(fields.title)}</h1><p class="note">[${escapeHtml(fields.note)}]</p>` +
        `<p class="path">${escapeHtml(page.path)}</p></body></html>`,
    )
  },
})

export const routesSite = defineSite({
  ...webSite,
  secrets: ['HOOK_TOKEN', 'MISSING_ONE'],
  routes: [
    defineRoute({
      method: 'POST',
      path: '/contact',
      handler: async (request, ctx) => {
        const body = request.body as Record<string, string>
        if (!body.email) return { status: 400, body: 'email required' }
        await ctx.fetch(`${ctx.baseUrl}/__hook`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ctx.secrets.HOOK_TOKEN ?? ''}` },
          body: body.email,
        })
        return ctx.render(ThankYou, { fields: { title: `Thanks ${body.email}` } })
      },
    }),
    defineRoute({
      method: 'POST',
      path: '/echo',
      handler: (request, ctx) => ({
        json: { request, secrets: ctx.secrets, locale: ctx.locale, baseUrl: ctx.baseUrl },
      }),
    }),
    defineRoute({
      method: 'GET',
      path: '/echo',
      handler: (request, ctx) => ({ json: { request, locale: ctx.locale } }),
    }),
    defineRoute({
      method: 'GET',
      path: '/api/latest',
      handler: async (_request, ctx) => ({ json: (await ctx.query.query('posts', { limit: 1 })).items.map((p) => p.slug) }),
    }),
    defineRoute({ method: 'GET', path: '/go', handler: (_request, ctx) => ctx.redirect('/') }),
    defineRoute({ method: 'GET', path: '/empty', handler: () => ({}) }),
    defineRoute({
      method: 'GET',
      path: '/text',
      handler: () => ({ status: 202, headers: { 'x-route': 'yes' }, body: 'plain <b>text</b>' }),
    }),
    defineRoute({
      method: 'GET',
      path: '/gone',
      handler: (_request, ctx) => ctx.render(ThankYou, { fields: { title: 'Gone' } }, { status: 410 }),
    }),
    defineRoute({
      method: 'GET',
      path: '/boom',
      handler: () => {
        throw new Error('route exploded')
      },
    }),
  ],
})
