import { defineConfig, defineContent, defineSite } from 'inlaycms/site'
import { site } from '../test-site/site.js'

/** Shipped content missing its required title. */
export default defineConfig({
  site: defineSite({ ...site, content: [defineContent('home', { edition: 1, content: { en: { fields: {} } } })] }),
})
