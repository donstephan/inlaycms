import { defineContent, defineSingleton, defineSite, defineTemplate, z } from 'inlaycms/site'
import hero from './hero.jpg'

/** A home page designed in code: no fields, no slots, an imported image. */
const Home = defineTemplate({
  name: 'home',
  fields: z.object({}),
  render: (_props, ctx) => {
    const img = ctx.image(hero, { alt: 'A hero' })
    return (
      <html>
        <body>
          <img src={img.src(1280)} srcset={img.srcset()} width={img.width} height={img.height} alt={img.alt} />
        </body>
      </html>
    )
  },
})

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [defineSingleton({ name: 'home', label: 'Home', template: Home, path: '/' })],
  content: [defineContent('home', { edition: 1, content: { en: { fields: {} } } })],
})
