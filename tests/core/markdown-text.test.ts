import { markdownHeadings, parseMarkdownText } from '../../src/core/richtext/markdown-text.js'

describe('parseMarkdownText', () => {
  it('accepts heading levels 1 to 6 and every feature', () => {
    const result = parseMarkdownText('# One\n\n###### Six\n\n**bold** `code` [a](https://example.com)\n\n- x\n\n> q\n')
    expect(result.ok).toBe(true)
  })

  it('does not fail on an image whose source is unknown', () => {
    expect(parseMarkdownText('![alt](./missing.png)').ok).toBe(true)
  })

  it('reports problems for text that does not read', () => {
    const result = parseMarkdownText('<div>raw html</div>')
    expect(result.ok).toBe(false)
  })

  it('maps a file: image to the given id, and an unknown one to the placeholder', () => {
    const images = new Map([['file:///s/a.png', 'a'.repeat(64)]])
    const result = parseMarkdownText('![A](file:///s/a.png) ![B](file:///s/b.png)', images)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const attrs = JSON.stringify(result.doc).match(/"type":"image","attrs":\{[^}]*\}/g)?.map((m) => JSON.parse(`{${m}}`).attrs)
    expect(attrs).toEqual([
      { media: 'a'.repeat(64), alt: 'A' },
      { media: '0'.repeat(64), alt: 'B' },
    ])
  })

  it('reports raw HTML as a problem with its line', () => {
    const result = parseMarkdownText('ok\n\n<div>x</div>\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]!.line).toBe(3)
  })
})

describe('markdownHeadings', () => {
  it('lists headings with ids and a prefix', () => {
    expect(markdownHeadings('# Intro\n\n## Intro\n', { prefix: 'p-' })).toEqual([
      { level: 1, text: 'Intro', id: 'p-intro' },
      { level: 2, text: 'Intro', id: 'p-intro-2' },
    ])
  })

  it('gives none when the text does not parse', () => {
    expect(markdownHeadings('<div>raw html</div>')).toEqual([])
  })
})

describe('inlay:key links', () => {
  it('reads as links to a document that never resolves', () => {
    const parsed = parseMarkdownText('[A](inlay:key/page/about) and [B](inlay:key/home)')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const marks = JSON.stringify(parsed.doc).match(/"document":"[^"]*"/g)
    expect(marks).toEqual(['"document":"00000000-0000-0000-0000-000000000000"', '"document":"00000000-0000-0000-0000-000000000000"'])
  })
})
