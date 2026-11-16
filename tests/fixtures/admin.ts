import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import { defineField } from '../../src/core/fields/define.js'
import { defineContent } from '../../src/core/registry/content.js'
import { defineBlock, defineSingleton, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { webSite } from './web.js'

export const Note = defineBlock({
  name: 'note',
  label: 'Note',
  help: 'A short note at the end of the page.',
  schema: z.object({ text: f.text({ label: 'Text' }) }),
})

/**
 * A template with one field of every simple kind, a group, a list, SEO, a plugin field without a widget, media,
 * references (one and many), links, rich text and an optional slot.
 */
export const Kitchen = defineTemplate({
  name: 'kitchen',
  label: 'Kitchen sink',
  fields: z.object({
    title: f.text({ label: 'Title', help: 'The name of the page.' }),
    intro: f.textarea({ label: 'Intro' }).optional(),
    count: f.number({ label: 'Count' }).optional(),
    featured: f.boolean({ label: 'Featured' }),
    tone: f.select(['calm', 'bold'], { label: 'Tone', setting: true }),
    day: f.date({ label: 'Day' }).optional(),
    at: f.datetime({ label: 'At' }).optional(),
    contact: f.group(
      { email: f.text({ label: 'Email' }), phone: f.text({ label: 'Phone' }).optional() },
      { label: 'Contact' },
    ),
    faq: f.list(z.object({ question: f.text({ label: 'Question' }), answer: f.textarea({ label: 'Answer' }) }), {
      label: 'FAQ',
      itemLabel: 'Question',
    }),
    seo: f.seo().optional(),
    custom: defineField(z.object({ x: z.number() }), { kind: 'custom', label: 'Custom' }).optional(),
    hero: f.image({ label: 'Hero image' }).optional(),
    doc: f.file({ label: 'Download' }).optional(),
    quote: f.ref('testimonials', { label: 'Quote' }).optional(),
    quotes: f.ref('testimonials', { label: 'Quotes', many: true }),
    cta: f.link({ label: 'Call to action' }),
    more: f.link({ label: 'More' }),
    body: f.richText({ label: 'Body', features: ['bold', 'link', 'image'] }),
  }),
  slots: {
    extra: { block: Note, optional: true },
  },
})

export const kitchen = defineSingleton({
  name: 'kitchen',
  label: 'Kitchen',
  template: Kitchen,
  path: null,
})

export const adminSite = defineSite({
  locales: ['en', 'es'],
  defaultLocale: 'en',
  singletons: [kitchen],
  collections: webSite.collections,
  content: [
    defineContent('kitchen', {
      edition: 1,
      content: {
        en: {
          fields: {
            title: 'Kitchen',
            featured: false,
            tone: 'calm',
            contact: { email: 'kitchen@example.com' },
            faq: [{ question: 'Why?', answer: 'Because.' }],
            quotes: [],
            cta: { url: '/blog', text: 'Read the blog' },
            more: { url: 'https://example.com/more', text: 'More' },
            body: 'Welcome to the **kitchen**.',
          },
          slots: { extra: false },
        },
      },
    }),
  ],
})
