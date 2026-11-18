import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '.vitepress', 'dist')
const base = '/inlaycms'

if (!existsSync(dist)) {
  console.error(`No build found at ${dist}. Run the docs build first.`)
  process.exit(1)
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith('.html')
        ? [join(dir, entry.name)]
        : [],
  )

const decode = (text) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))

const safeDecodeURI = (text) => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

const files = walk(dist)
const idsByFile = new Map()
const pages = new Map()
for (const file of files) {
  const html = readFileSync(file, 'utf8')
  pages.set(file, html)
  const ids = new Set()
  for (const match of html.matchAll(/\sid=(?:"([^"]*)"|'([^']*)')/g)) {
    ids.add(decode(match[1] ?? match[2] ?? ''))
  }
  idsByFile.set(file, ids)
}

const targetFile = (path) => {
  let rest = path.startsWith(base) ? path.slice(base.length) : path
  if (rest === '' || rest === '/') return join(dist, 'index.html')
  if (rest.endsWith('/')) return join(dist, rest, 'index.html')
  if (rest.endsWith('.html')) return join(dist, rest)
  return join(dist, `${rest}.html`)
}

const problems = []
for (const [file, html] of pages) {
  const name = relative(dist, file)
  for (const match of html.matchAll(/\shref=(?:"([^"]*)"|'([^']*)')/g)) {
    const href = decode(match[1] ?? match[2] ?? '')
    const hash = href.indexOf('#')
    if (hash === -1) continue
    const path = href.slice(0, hash).split('?')[0]
    const fragment = safeDecodeURI(href.slice(hash + 1))
    if (fragment === '' || fragment === 'VPContent') continue
    let target
    if (path === '') target = file
    else if (path === base || path.startsWith(`${base}/`)) target = targetFile(path)
    else continue
    const ids = idsByFile.get(target)
    if (!ids) problems.push(`${name}: ${href} (no such page)`)
    else if (!ids.has(fragment)) problems.push(`${name}: ${href} (no heading or id "${fragment}")`)
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} broken link fragment(s):`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`Checked ${files.length} pages, all link fragments resolve.`)
