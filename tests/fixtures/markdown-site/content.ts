import { defineEntries } from 'inlaycms/site'
import page from './page.md'

export const content = [
  defineEntries('page', [{ key: 'about', edition: 1, content: { en: { slug: 'about', fields: { title: 'About' } } } }]),
  /** The same `.md` the `/page` route renders through `ctx.markdown`, shipped as rich text. */
  defineEntries('note', [
    { key: 'field-notes', edition: 1, content: { en: { slug: 'field-notes', fields: { title: 'Field notes', body: page } } } },
  ]),
]
