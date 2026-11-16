import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import { defineCollection, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { site } from './site.js'

export const Article = defineTemplate({
  name: 'article',
  label: 'Article',
  fields: z.object({
    title: f.text({ label: 'Title', maxLength: 120 }),
    body: f.richText({ label: 'Body' }),
    summary: f.richText({ label: 'Summary', features: ['bold', 'italic', 'link'] }).optional(),
    cover: f.image({ label: 'Cover' }).optional(),
    attachment: f.file({ label: 'Attachment' }).optional(),
  }),
  render: (p) => `<article>${p.fields.title}</article>`,
})

export const articleSite = defineSite({
  ...site,
  collections: [
    ...site.collections,
    defineCollection({ name: 'articles', label: 'Articles', template: Article, route: '/articles/:slug' }),
  ],
})
