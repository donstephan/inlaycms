import { defineIntegration, f, z } from 'inlaycms/site'

export const visitCounter = defineIntegration({
  name: 'visit-counter',
  label: 'Visit counter',
  description: 'Counts the pages a visitor opens in one browser session. It loads nothing from outside the site.',
  consent: 'analytics',
  fields: z.object({
    label: f.text({ label: 'Counter label' }).optional(),
  }),
  bodyEnd: (_, page) => page.script({ src: '/public/visits.js', defer: true }),
})
