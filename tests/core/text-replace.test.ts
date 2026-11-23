import { findPhrase } from '../../src/core/content/text-match.js'
import { replaceText } from '../../src/core/content/text-replace.js'
import { markdownToRichText, richTextToMarkdown } from '../../src/core/richtext/markdown.js'

const md = (s: string) => {
  const result = markdownToRichText(s)
  if (!result.ok) throw new Error('markdown did not parse')
  return result.doc
}

describe('replaceText', () => {
  it('replaces every whole-word occurrence in plain text', () => {
    expect(replaceText('text', 'Acme and Acmeville and Acme', 'Acme', 'Globex')).toEqual({ ok: true, value: 'Globex and Acmeville and Globex', count: 2 })
  })
  it('replaces only the numbered occurrences', () => {
    expect(replaceText('textarea', 'Acme, Acme Corp, Acme', 'Acme', 'Globex', [1, 3, 3])).toEqual({ ok: true, value: 'Globex, Acme Corp, Globex', count: 2 })
  })
  it('does not re-match its own output', () => {
    expect(replaceText('text', 'Acme', 'Acme', 'Acme Corp')).toEqual({ ok: true, value: 'Acme Corp', count: 1 })
  })
  it('reports a missing phrase and an out-of-range occurrence', () => {
    expect(replaceText('text', 'ACME', 'Acme', 'X')).toEqual({ ok: false, reason: 'notFound', count: 0 })
    expect(replaceText('text', 'Acme', 'Acme', 'X', [2])).toEqual({ ok: false, reason: 'occurrence', count: 1 })
    expect(replaceText('text', 'Acme', 'Acme', 'X', [0])).toEqual({ ok: false, reason: 'occurrence', count: 1 })
    expect(replaceText('text', 'Acme', 'Acme', 'X', [1.5])).toEqual({ ok: false, reason: 'occurrence', count: 1 })
  })
  it('refuses an empty list of occurrences', () => {
    expect(replaceText('text', 'Acme and Acme', 'Acme', 'X', [])).toEqual({ ok: false, reason: 'noOccurrences', count: 2 })
    expect(replaceText('richText', md('Acme'), 'Acme', 'X', [])).toEqual({ ok: false, reason: 'noOccurrences', count: 1 })
  })
  it('numbers the same occurrences find_text does when the phrase overlaps itself', () => {
    expect(findPhrase('A a a a', 'a a', 'loose').filter((h) => h.text === 'a a').map((h) => h.start)).toEqual([4])
    expect(replaceText('text', 'A a a a', 'a a', 'X')).toEqual({ ok: true, value: 'A a X', count: 1 })
    expect(replaceText('text', 'A a a a', 'a a', 'X', [1])).toEqual({ ok: true, value: 'A a X', count: 1 })
    expect(replaceText('text', 'A a a a', 'a a', 'X', [2])).toMatchObject({ ok: false, reason: 'occurrence', count: 1 })
    const result = replaceText('richText', md('A a a a'), 'a a', 'X')
    if (!result.ok) throw new Error()
    expect(richTextToMarkdown(result.value as never)).toBe('A a X')
  })
  it('replaces inside inline text, keeping marks', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'text', text: 'Acme', marks: [{ type: 'bold' }] }] }] }
    const result = replaceText('inlineText', doc, 'Acme', 'Globex')
    expect(result).toMatchObject({ ok: true, count: 1 })
    if (!result.ok) throw new Error()
    expect(result.value).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'text', text: 'Globex', marks: [{ type: 'bold' }] }] }] })
  })
  it('changes only a link label', () => {
    const link = { url: 'https://acme.test/Acme', text: 'Try Acme' }
    expect(replaceText('link', link, 'Acme', 'Globex')).toEqual({ ok: true, value: { url: 'https://acme.test/Acme', text: 'Try Globex' }, count: 1 })
    expect(replaceText('link', { url: '/x' }, 'Acme', 'Globex')).toMatchObject({ ok: false, reason: 'notFound' })
    expect(link.text).toBe('Try Acme')
  })
  it('replaces inside rich text, keeping marks and links', () => {
    const doc = md('Hi **Acme** and [Acme site](https://acme.test/Acme).')
    const result = replaceText('richText', doc, 'Acme', 'Globex')
    expect(result).toMatchObject({ ok: true, count: 2 })
    if (!result.ok) throw new Error()
    expect(richTextToMarkdown(result.value as never)).toBe('Hi **Globex** and [Globex site](https://acme.test/Acme).')
    expect(richTextToMarkdown(doc)).toBe('Hi **Acme** and [Acme site](https://acme.test/Acme).')
  })
  it('refuses an occurrence that spans formatting unless it is left out', () => {
    const doc = md('**Ac**me and Acme')
    expect(replaceText('richText', doc, 'Acme', 'X')).toEqual({ ok: false, reason: 'spansFormatting', count: 2 })
    const result = replaceText('richText', doc, 'Acme', 'X', [2])
    if (!result.ok) throw new Error()
    expect(richTextToMarkdown(result.value as never)).toBe('**Ac**me and X')
  })
  it('removes a text node left empty and keeps Markdown in replace literal', () => {
    const emptied = replaceText('richText', md('**Acme**\n\nkeep'), 'Acme', '')
    if (!emptied.ok) throw new Error()
    expect(JSON.stringify(emptied.value)).not.toContain('"text":""')
    const literal = replaceText('richText', md('Acme'), 'Acme', '**x**')
    if (!literal.ok) throw new Error()
    expect(JSON.stringify(literal.value)).toContain('"text":"**x**"')
  })
})
