import { tmpdir } from 'node:os'
import { defineConfig } from 'inlaycms/site'
import { site } from '../test-site/site.js'

/** `loadConfig` loads this; `inlaycms pack` refuses the `node:os` import. */
export const scratch = tmpdir()

export default defineConfig({ site })
