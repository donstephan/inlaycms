import { pathToFileURL } from 'node:url'

/** The name of the export a bundled `site.js` carries to say which folder it was built from. */
export const SITE_DIR_EXPORT = '__inlaySiteDir'

/** The folder `dir` as a `file:` URL ending in one `/`. */
export function siteDirUrl(dir: string): string {
  const href = pathToFileURL(dir).href
  return href.endsWith('/') ? href : `${href}/`
}
