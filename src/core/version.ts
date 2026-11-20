import { readFileSync } from 'node:fs'

export function inlayVersion(): string {
  const url = new URL('../../package.json', import.meta.url)
  return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version
}

/** The oldest Inlay version whose releases this one still runs. See the upgrades spec and CLAUDE.md. */
export const OLDEST_RELEASE = '0.5.0'

/** The oldest version the next window will keep, when already decided: older releases get a "pack again" warning. */
export const NEXT_OLDEST_RELEASE: string | null = null

/** The first Inlay version whose releases serve their `public/` files at the site root too. */
export const ROOT_PUBLIC_FILES_SINCE = '0.7.0'
