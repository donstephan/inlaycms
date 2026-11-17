import { z } from 'zod'
import { f } from '../../src/core/fields/builtins.js'
import { defineGlobal, defineSite, defineTemplate, type SiteDefinition } from '../../src/core/registry/define.js'

/** A global whose lists nest three deep: menu items hold columns, and columns hold links. */
export const Menu = defineTemplate({
  name: 'menu',
  label: 'Menu',
  fields: z.object({
    menu: f.list(
      z.object({
        title: f.text({ label: 'Title' }),
        columns: f.list(
          z.object({
            heading: f.text({ label: 'Heading' }),
            links: f.list(
              z.object({
                label: f.text({ label: 'Label' }),
                href: f.text({ label: 'Address' }),
                description: f.textarea({ label: 'Description' }).optional(),
              }),
              { label: 'Links', itemLabel: 'Link' },
            ),
          }),
          { label: 'Columns', itemLabel: 'Column' },
        ),
      }),
      { label: 'Menu', itemLabel: 'Menu item' },
    ),
    promo: f.group({ text: f.text({ label: 'Text' }), link: f.link({ label: 'Link' }) }, { label: 'Promo' }),
  }),
})

export const megaMenuSite: SiteDefinition = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  globals: [defineGlobal({ name: 'menu', label: 'Menu', template: Menu })],
})
