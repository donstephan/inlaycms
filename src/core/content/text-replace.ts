import { isRecord } from '../fields/zod-internals.js'
import type { RichTextDoc } from '../richtext/schema.js'
import { textRuns, type TextPiece } from '../richtext/runs.js'
import { findPhrase, type PhraseHit } from './text-match.js'

export type ReplaceKind = 'text' | 'textarea' | 'richText' | 'inlineText' | 'link'

type ReplaceFailure = { ok: false; reason: 'notFound' | 'occurrence' | 'noOccurrences' | 'spansFormatting'; count: number }

export type ReplaceResult = { ok: true; value: unknown; count: number } | ReplaceFailure

/**
 * The occurrences of `find` in `text`: the hits find_text reports for it that are written exactly as `find`,
 * so both number the same occurrences.
 */
const occurrencesOf = (text: string, find: string): PhraseHit[] =>
  findPhrase(text, find, 'loose').filter((hit) => hit.text === find)

/** The numbers picked by the caller, or null for "all"; a failure when there are none or one is out of range. */
function selection(occurrences: number[] | undefined, count: number): Set<number> | null | ReplaceFailure {
  if (occurrences === undefined) return null
  if (occurrences.length === 0) return { ok: false, reason: 'noOccurrences', count }
  for (const n of occurrences) if (!Number.isInteger(n) || n < 1 || n > count) return { ok: false, reason: 'occurrence', count }
  return new Set(occurrences)
}

function replaceInString(text: string, find: string, replace: string, occurrences?: number[]): ReplaceResult {
  const hits = occurrencesOf(text, find)
  if (hits.length === 0) return { ok: false, reason: 'notFound', count: 0 }
  const picked = selection(occurrences, hits.length)
  if (picked !== null && !(picked instanceof Set)) return picked
  let out = ''
  let at = 0
  let count = 0
  hits.forEach((hit, i) => {
    if (picked && !picked.has(i + 1)) return
    out += text.slice(at, hit.start) + replace
    at = hit.end
    count++
  })
  out += text.slice(at)
  return { ok: true, value: out, count }
}

function pruneEmptyText(node: { content?: unknown }): void {
  if (!Array.isArray(node.content)) return
  const kept = node.content.filter((child) => !(isRecord(child) && child.type === 'text' && child.text === ''))
  for (const child of kept) if (isRecord(child)) pruneEmptyText(child)
  if (kept.length === 0) delete node.content
  else node.content = kept
}

function replaceInRichText(value: unknown, find: string, replace: string, occurrences?: number[]): ReplaceResult {
  if (!isRecord(value) || value.type !== 'doc' || !Array.isArray(value.content)) {
    return { ok: false, reason: 'notFound', count: 0 }
  }
  const doc = structuredClone(value) as unknown as RichTextDoc
  const found: Array<{ piece: TextPiece; start: number; end: number; spans: boolean; number: number }> = []
  let total = 0
  for (const run of textRuns(doc)) {
    for (const hit of occurrencesOf(run.text, find)) {
      total++
      const piece = run.pieces.find((p) => hit.start >= p.start && hit.end <= p.end)
      found.push({
        piece: piece ?? run.pieces[0]!,
        start: piece ? hit.start - piece.start : 0,
        end: piece ? hit.end - piece.start : 0,
        spans: !piece,
        number: total,
      })
    }
  }
  if (total === 0) return { ok: false, reason: 'notFound', count: 0 }
  const picked = selection(occurrences, total)
  if (picked !== null && !(picked instanceof Set)) return picked
  const chosen = found.filter((f) => !picked || picked.has(f.number))
  if (chosen.some((f) => f.spans)) return { ok: false, reason: 'spansFormatting', count: total }
  for (const f of [...chosen].reverse()) {
    const node = f.piece.node
    node.text = node.text.slice(0, f.start) + replace + node.text.slice(f.end)
  }
  pruneEmptyText(doc as { content?: unknown })
  return { ok: true, value: doc, count: chosen.length }
}

/** Swaps a phrase, exactly as written, inside one field's stored value. Never mutates `value`. */
export function replaceText(
  kind: ReplaceKind,
  value: unknown,
  find: string,
  replace: string,
  occurrences?: number[],
): ReplaceResult {
  if (kind === 'richText' || kind === 'inlineText') return replaceInRichText(value, find, replace, occurrences)
  if (kind === 'link') {
    if (!isRecord(value) || typeof value.text !== 'string') return { ok: false, reason: 'notFound', count: 0 }
    const result = replaceInString(value.text, find, replace, occurrences)
    return result.ok ? { ...result, value: { ...value, text: result.value } } : result
  }
  if (typeof value !== 'string') return { ok: false, reason: 'notFound', count: 0 }
  return replaceInString(value, find, replace, occurrences)
}
