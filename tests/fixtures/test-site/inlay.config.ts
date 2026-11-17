import { defineConfig } from 'inlaycms/site'
import { site } from './site.js'

/** The `db` is never opened by a test site: tests check that `data/` never appears. */
export default defineConfig({ site, db: './data/inlay.db' })
