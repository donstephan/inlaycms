::: code-group

```tsx [page.tsx]
import { defineTemplate, f, z } from 'inlaycms/site'

export const Page = defineTemplate({
  name: 'page',
  fields: z.object({
    title: f.text({ label: 'Title' }),
    body: f.richText({ label: 'Body' }),
  }),
  render: ({ fields }, ctx) => (
    <html lang={ctx.locale}>
      <head><title>{fields.title}</title></head>
      <body>
        <h1>{fields.title}</h1>
        {ctx.richText(fields.body)}
      </body>
    </html>
  ),
})
```

```tsx [site.tsx]
import { defineSingleton, defineSite } from 'inlaycms/site'
import { Page } from './page.js'

export const site = defineSite({
  locales: ['en'],
  defaultLocale: 'en',
  singletons: [
    defineSingleton({
      name: 'home',
      label: 'Home page',
      help: 'The front page of the site.',
      template: Page,
      path: '/',
    }),
  ],
})
```

```sh [terminal]
# Run it locally, with the admin at /admin
npx inlaycms dev

# Check the live content fits the new code
npx inlaycms check

# Pack a signed release
npx inlaycms pack --key keys/release.key

# Send it to your host and make it live
npx inlaycms push https://example.com \
  --key keys/release.key --activate
```

:::
