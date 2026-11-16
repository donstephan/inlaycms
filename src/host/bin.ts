import { fileURLToPath } from 'node:url'

/** `.ts` when running from `src/` (tsx, vitest), `.js` from `dist/`. */
const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js'

/**
 * The `inlaycms` command's own file. `serve` runs it for each worker and `dev` for its child, so they start the same
 * code however the command was started (a symlinked bin, a wrapper script).
 */
export const INLAY_BIN = fileURLToPath(new URL(`../adapters/cli/bin${EXT}`, import.meta.url))
