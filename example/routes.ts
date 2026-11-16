import { defineRoute } from 'inlaycms/site'
import type { RouteDef, TemplateDef } from 'inlaycms/site'

const copy: Record<string, { thanks: string; note: string; missing: string; missingNote: string }> = {
  en: {
    thanks: 'Thank you',
    note: 'We got your message and will reply within two working days.',
    missing: 'Please add your email',
    missingNote: 'We need an email address to reply to you. Go back and try again.',
  },
  es: {
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

/** The contact form on the About page posts here. `thankYou` is the template the answer renders with. */
export function contactRoutes(thankYou: TemplateDef): RouteDef[] {
  return [
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
