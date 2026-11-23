/** Lower-cased text without accents, with each normalized character's index in the original. */
export function fold(text: string): { text: string; index: number[] } {
  let out = ''
  const index: number[] = []
  let i = 0
  for (const ch of text) {
    for (const c of ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()) {
      out += c
      index.push(i)
    }
    i += ch.length
  }
  return { text: out, index }
}

export interface PhraseHit {
  start: number
  end: number
  text: string
}

const WORD = /^[\p{L}\p{N}\p{M}]$/u

const firstChar = (s: string) => [...s][0] ?? ''
const lastChar = (s: string) => [...s].at(-1) ?? ''

function charBefore(text: string, at: number): string {
  if (at <= 0) return ''
  const code = text.charCodeAt(at - 1)
  if (code >= 0xdc00 && code <= 0xdfff && at >= 2) return text.slice(at - 2, at)
  return text.slice(at - 1, at)
}

function charAt(text: string, at: number): string {
  return String.fromCodePoint(text.codePointAt(at) ?? 0x20)
}

function edgesOk(text: string, start: number, end: number, phrase: string): boolean {
  if (WORD.test(firstChar(phrase)) && start > 0 && WORD.test(charBefore(text, start))) return false
  if (WORD.test(lastChar(phrase)) && end < text.length && WORD.test(charAt(text, end))) return false
  return true
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Non-overlapping whole-word hits of a phrase, left to right, as offsets into `text`. None for a phrase that is blank once loose matching drops accents. */
export function findPhrase(text: string, phrase: string, mode: 'loose' | 'exact'): PhraseHit[] {
  if (phrase.trim() === '') return []
  const hits: PhraseHit[] = []
  if (mode === 'exact') {
    let from = 0
    for (;;) {
      const at = text.indexOf(phrase, from)
      if (at === -1) break
      const end = at + phrase.length
      if (edgesOk(text, at, end, phrase)) {
        hits.push({ start: at, end, text: text.slice(at, end) })
        from = end
      } else {
        from = at + 1
      }
    }
    return hits
  }
  const parts = fold(phrase).text.split(/\s+/).filter((p) => p !== '')
  if (parts.length === 0) return []
  const folded = fold(text)
  const regex = new RegExp(parts.map(escapeRegExp).join('\\s+'), 'gu')
  const edge = phrase.trim()
  for (;;) {
    const m = regex.exec(folded.text)
    if (!m) break
    const matchStart = m.index
    const matchEnd = matchStart + m[0].length
    if (matchEnd === matchStart) {
      regex.lastIndex = matchStart + 1
      continue
    }
    const start = folded.index[matchStart] ?? 0
    let end = text.length
    const lastOriginal = folded.index[matchEnd - 1]
    for (let k = matchEnd; k < folded.index.length; k++) {
      const original = folded.index[k]
      if (original !== undefined && original !== lastOriginal) {
        end = original
        break
      }
    }
    if (edgesOk(text, start, end, edge)) {
      hits.push({ start, end, text: text.slice(start, end) })
    } else {
      regex.lastIndex = matchStart + 1
    }
  }
  return hits
}

/** About `size` characters of `text` centered on a hit, trimmed. */
export function snippetAround(text: string, hit: PhraseHit, size: number): string {
  const center = Math.floor((hit.start + hit.end) / 2)
  const start = Math.max(0, center - Math.floor(size / 2))
  return text.slice(start, start + size).trim()
}
