import { defineRoute } from 'inlaycms/site'
import type { RouteDef, TemplateDef } from 'inlaycms/site'

const copy: Record<string, { contact: string; thanks: string; note: string; missing: string; missingNote: string }> = {
  en: {
    contact: 'Contact us',
    thanks: 'Thank you',
    note: 'We got your message and will reply within two working days.',
    missing: 'Please add your email',
    missingNote: 'We need an email address to reply to you. Go back and try again.',
  },
  es: {
    contact: 'Contactanos',
    thanks: 'Gracias',
    note: 'Recibimos tu mensaje y te responderemos en dos dias habiles.',
    missing: 'Falta tu email',
    missingNote: 'Necesitamos un email para responderte. Vuelve e intentalo de nuevo.',
  },
}

function field(body: unknown, name: string): string {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined
  return typeof value === 'string' ? value.trim() : ''
}

/** The contact form on the About page posts here. `thankYou` is the template the answer renders with, `contact` the one `GET /contact` renders. */
export function contactRoutes(thankYou: TemplateDef, contact: TemplateDef): RouteDef[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/contact',
      sitemap: true,
      handler: async (_request, ctx) => {
        const text = copy[ctx.locale] ?? copy.en!
        return ctx.render(contact, { fields: { title: text.contact } })
      },
    }),
    defineRoute({
      method: 'POST',
      path: '/contact',
      handler: async (request, ctx) => {
        const text = copy[ctx.locale] ?? copy.en!
        const email = field(request.body, 'email')
        const message = field(request.body, 'message')
        if (!email) {
          return ctx.render(thankYou, { fields: { title: text.missing, note: text.missingNote } }, { status: 400 })
        }
        const webhook = ctx.secrets.SLACK_WEBHOOK
        if (webhook) {
          await ctx.fetch(webhook, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: `New message from ${email}:\n${message}`, email, message }),
          })
        }
        return ctx.render(thankYou, { fields: { title: text.thanks, note: text.note } })
      },
    }),
  ]
}

/** `GET /colophon`: the template renders `pages/colophon.md`. */
export function colophonRoute(colophon: TemplateDef): RouteDef {
  return defineRoute({
    method: 'GET',
    path: '/colophon',
    sitemap: true,
    handler: (_request, ctx) => ctx.render(colophon, { fields: { title: 'Colophon' } }),
  })
}
