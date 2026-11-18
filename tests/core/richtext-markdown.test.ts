import { t } from '../../src/core/messages/index.js'
import { markdownImages, markdownToRichText, richTextToMarkdown, type RichTextProblem } from '../../src/core/richtext/markdown.js'
import { DEFAULT_RICH_TEXT, parseRichText, richTextText, type RichTextDoc } from '../../src/core/richtext/schema.js'

const uuid = '6f1c2b1e-8a3d-4b7e-9c2a-000000000001'
const sha = 'ab'.repeat(32)

const para = (...content: unknown[]) => ({ type: 'paragraph', content })
const text = (s: string, marks?: unknown[]) => (marks ? { type: 'text', text: s, marks } : { type: 'text', text: s })
const item = (...content: unknown[]) => ({ type: 'listItem', content })
const bold = { type: 'bold' }
const italic = { type: 'italic' }
const code = { type: 'code' }
const link = (href: string) => ({ type: 'link', attrs: { href } })

function doc(...content: unknown[]): RichTextDoc {
  const parsed = parseRichText({ type: 'doc', content }, DEFAULT_RICH_TEXT)
  if (!parsed.ok) throw new Error('test doc is not valid')
  return parsed.doc
}

function roundTrip(d: RichTextDoc) {
  const markdown = richTextToMarkdown(d)
  const back = markdownToRichText(markdown)
  return { markdown, back }
}

function expectRoundTrip(d: RichTextDoc) {
  const { markdown, back } = roundTrip(d)
  expect(back, markdown).toEqual({ ok: true, doc: d })
}

/** Each visible character with the bold and italic on it. */
function emphasis(d: RichTextDoc): string[] {
  const out: string[] = []
  const visit = (node: unknown): void => {
    const n = node as { type?: string; text?: string; marks?: { type: string }[]; content?: unknown[] }
    if (n.type === 'text') {
      for (const c of n.text ?? '') {
        if (/\S/.test(c)) out.push(c + (n.marks ?? []).filter((m) => m.type !== 'link').map((m) => m.type).join())
      }
    }
    n.content?.forEach(visit)
  }
  visit(d)
  return out
}

function problems(markdown: string, opts?: Parameters<typeof markdownToRichText>[1]): RichTextProblem[] {
  const result = markdownToRichText(markdown, opts)
  if (result.ok) throw new Error(`expected problems for ${JSON.stringify(markdown)}`)
  return result.problems
}

const full = doc(
  { type: 'heading', attrs: { level: 2 }, content: [text('Heading')] },
  para(
    text('Some '),
    text('bold', [bold]),
    text(' and '),
    text('italic', [italic]),
    text(' text with a '),
    text('link', [link('https://example.com')]),
    text(' and '),
    text('About', [{ type: 'link', attrs: { document: uuid } }]),
    text('.'),
  ),
  {
    type: 'bulletList',
    content: [item(para(text('One'))), item(para(text('Two')), { type: 'bulletList', content: [item(para(text('Nested')))] })],
  },
  { type: 'orderedList', attrs: { start: 3 }, content: [item(para(text('Three'))), item(para(text('Four')))] },
  { type: 'blockquote', content: [para(text('Quoted'))] },
  para(text('Line one'), { type: 'hardBreak' }, text('line two')),
  para({ type: 'image', attrs: { media: sha, alt: 'A photo' } }),
)

describe('richTextToMarkdown', () => {
  it('writes every feature as CommonMark', () => {
    expect(richTextToMarkdown(full)).toBe(
      [
        '## Heading',
        '',
        `Some **bold** and *italic* text with a [link](https://example.com) and [About](inlay:document/${uuid}).`,
        '',
        '- One',
        '- Two',
        '  - Nested',
        '',
        '3. Three',
        '4. Four',
        '',
        '> Quoted',
        '',
        'Line one\\',
        'line two',
        '',
        `![A photo](inlay:media/${sha})`,
      ].join('\n'),
    )
  })

  it('round-trips the full doc', () => {
    expectRoundTrip(full)
  })

  it.each([
    '2 * 3 = 6',
    'snake_case_name',
    '[not a link]',
    '1. not a list',
    '# not a heading',
    '> not a quote',
    '- not a list',
    '+1 for this',
    '<b>not html</b>',
    'AT&T and &amp; literal',
    'C:\\path\\to',
    '`backticks`',
    '¿Qué? Café 🎉',
    '1.',
    '1) not a list',
    '+',
    '    indented - not code',
    ' - leading space',
    '<https://example.com>',
    '&#32; and &copy;',
    'wow!',
    '***',
    '___',
    '_a_',
  ])('round-trips the text %j', (s) => {
    expectRoundTrip(doc(para(text(s))))
  })

  it.each(['https://example.com/a_(b)', '/about us', '/a\uE000\uE004b', '/a b\uE001', 'https://example.com/a\\b', 'https://example.com/?a=1&amp;b=2'])(
    'round-trips a link to %j',
    (href) => {
      expectRoundTrip(doc(para(text('go', [link(href)]))))
    },
  )

  it('round-trips awkward text in headings, lists, quotes and after hard breaks', () => {
    expectRoundTrip(doc({ type: 'heading', attrs: { level: 3 }, content: [text('C# and x #')] }))
    expectRoundTrip(doc({ type: 'heading', attrs: { level: 2 }, content: [text('#')] }))
    expectRoundTrip(doc({ type: 'bulletList', content: [item(para(text('- dash'))), item(para(text('1. one')))] }))
    expectRoundTrip(doc({ type: 'blockquote', content: [para(text('> nested?'))] }))
    for (const after of ['- b', '1. b', '+ b', '# b', '> b', '===', '---', ' b']) {
      expectRoundTrip(doc(para(text('a'), { type: 'hardBreak' }, text(after))))
    }
    expectRoundTrip(doc(para(text('a'), { type: 'hardBreak' }, { type: 'hardBreak' }, text('b'))))
  })

  it('round-trips marks on images and hard breaks', () => {
    expectRoundTrip(doc(para({ type: 'image', attrs: { media: sha, alt: 'x' }, marks: [link('https://example.com')] })))
    expectRoundTrip(doc(para({ type: 'image', attrs: { media: sha }, marks: [bold] })))
    expectRoundTrip(doc(para(text('a', [bold]), { type: 'hardBreak', marks: [bold] }, text('b', [bold]))))
    expectRoundTrip(doc(para(text('wow!'), text('link', [link('/x')]))))
    expectRoundTrip(doc(para(text('both', [bold, italic]), text(' then '), text('it', [italic]))))
  })

  it('does not crash on hard breaks at the edges or marks around them', () => {
    expect(() => richTextToMarkdown(doc(para(text('a', [bold]), { type: 'hardBreak', marks: [bold] })))).not.toThrow()
    expect(() => richTextToMarkdown(doc(para({ type: 'hardBreak' }, text('b'))))).not.toThrow()
    expect(() => richTextToMarkdown(doc(para({ type: 'image', attrs: { media: sha, alt: 'a\n\nb [x]' } })))).not.toThrow()
  })

  it('keeps adjacent lists apart', () => {
    expectRoundTrip(
      doc({ type: 'bulletList', content: [item(para(text('a')))] }, { type: 'bulletList', content: [item(para(text('b')))] }),
    )
    expectRoundTrip(
      doc(
        { type: 'orderedList', content: [item(para(text('a')))] },
        { type: 'orderedList', content: [item(para(text('b')))] },
      ),
    )
  })

  it('separates a nested list that could not interrupt the paragraph above it', () => {
    const three = { type: 'orderedList', attrs: { start: 3 }, content: [item(para(text('b')))] }
    const empty = { type: 'bulletList', content: [item({ type: 'paragraph' })] }
    const nested = (...content: unknown[]) => doc({ type: 'bulletList', content: [item(...content)] })
    expect(richTextToMarkdown(nested(para(text('a')), three))).toBe('- a\n\n  3. b')
    expectRoundTrip(nested(para(text('a')), three))
    expectRoundTrip(nested(para(text('x')), empty))
    expect(markdownToRichText(richTextToMarkdown(nested(para(text('x')), empty)), { headings: [] }).ok).toBe(true)
    expectRoundTrip(nested(para(text('a')), { type: 'bulletList', content: [item(para(text('b')))] }, three))
    expectRoundTrip(nested(para(text('a')), { type: 'blockquote', content: [para(text('q'))] }, three))
    expectRoundTrip(doc({ type: 'blockquote', content: [para(text('q')), three] }))
    expectRoundTrip(doc({ type: 'bulletList', content: [item(para(text('a')), three), item(para(text('c')))] }))
    expectRoundTrip(doc({ type: 'bulletList', content: [item(para(text('a')), { type: 'orderedList', content: [item(para(text('b')))] })] }))
    const deep = doc({
      type: 'bulletList',
      content: [item({ type: 'paragraph' }, { type: 'bulletList', content: [item({ type: 'paragraph' }, empty)] })],
    })
    expect(richTextToMarkdown(deep)).toBe('- * - ')
    expectRoundTrip(deep)
  })

  it('writes bold and italic next to punctuation and each other so they read back', () => {
    const cases = [
      doc(para(text('He said'), text('"hi"', [italic]), text(' ok'))),
      doc(para(text('a', [bold]), text('b', [bold, italic]), text('c', [italic]))),
      doc(para(text('a', [italic]), text('b', [bold]))),
      doc(para(text('x'), text('(y)', [bold]), text('z'))),
      doc(para(text('a', [bold, italic]), text('b', [bold]), text('c', [bold, italic]))),
      doc(para(text('!(', [bold, italic]), text('z', [bold]), text('-', [bold, italic]))),
      doc(para(text('x_y'), text('z', [italic]), text('!'))),
      doc(para(text('snake_case', [bold]), text('_', [italic]), text('x'))),
      doc(para(text('mid'), text('word', [bold]), text('s'))),
      doc(para(text('a', [bold]), { type: 'hardBreak', marks: [bold] }, { type: 'hardBreak', marks: [bold] }, text('b'))),
      doc(para(text('x['), text('!', [bold, italic]), text(' ', [italic]))),
    ]
    for (const d of cases) {
      const { markdown, back } = roundTrip(d)
      expect(back.ok, markdown).toBe(true)
      if (!back.ok) continue
      expect(richTextText(back.doc), markdown).toBe(richTextText(d))
      expect(emphasis(back.doc), markdown).toEqual(emphasis(d))
    }
    expect(richTextToMarkdown(cases[0]!)).toBe('He sai&#100;*"hi"* ok')
    expect(richTextToMarkdown(cases[1]!)).toBe('**&#97;_b_**_c_')
    expect(richTextToMarkdown(doc(para(text('Some '), text('bold', [bold]), text(' text'))))).toBe('Some **bold** text')
  })

  it('round-trips whitespace at the ends of a paragraph', () => {
    expectRoundTrip(doc(para(text('a '))))
    expectRoundTrip(doc(para(text('\u00a0a\u00a0'))))
    expectRoundTrip(doc({ type: 'heading', attrs: { level: 2 }, content: [text('a ')] }))
  })

  it('keeps bold and italic when a link next to them has spaces at its ends', () => {
    const cases = [
      doc(para(text('Tip:', [bold]), text(' '), text('Click here ', [link('/guide'), italic]), text('to read the guide.', [italic]))),
      doc(para(text(' x', [link('/a'), bold]))),
      doc(para(text('a '), text(' b ', [link('/a'), bold, italic]), text(' c', [bold]))),
    ]
    for (const d of cases) {
      const { markdown, back } = roundTrip(d)
      expect(back.ok, markdown).toBe(true)
      if (!back.ok) continue
      expect(richTextText(back.doc), markdown).toBe(richTextText(d))
      expect(emphasis(back.doc), markdown).toEqual(emphasis(d))
    }
    expect(richTextToMarkdown(cases[0]!)).toBe('**Tip:** [*Click here* ](/guide)*to read the guide.*')
  })

  it('keeps lists apart and in place around paragraphs that were only line breaks', () => {
    const br = { type: 'hardBreak' }
    const list = (s: string) => ({ type: 'bulletList', content: [item(para(text(s)))] })
    expectRoundTrip(doc(list('a'), para(br), list('b')))
    expect(markdownToRichText(richTextToMarkdown(doc(list('a'), para(br), list('b'))))).toEqual({
      ok: true,
      doc: doc(list('a'), list('b')),
    })
    const intro = doc({
      type: 'bulletList',
      content: [item(para(text('Intro')), { type: 'bulletList', content: [item({ type: 'paragraph' }, para(br))] })],
    })
    expect(markdownToRichText(richTextToMarkdown(intro), { headings: [] }).ok).toBe(true)
    expectRoundTrip(intro)
    const inList = richTextToMarkdown(doc({ type: 'bulletList', content: [item({ type: 'paragraph' }, para(br), para(text('x')))] }))
    expect(markdownToRichText(inList)).toEqual({ ok: true, doc: doc({ type: 'bulletList', content: [item(para(text('x')))] }) })
  })

  it('lines up a numbered list that starts on its parent item\'s first line', () => {
    const steps = (start: number, count: number) => ({
      type: 'orderedList',
      attrs: { start },
      content: Array.from({ length: count }, (_, i) => item(para(text(`step ${i}`)))),
    })
    const tenSteps = doc({ type: 'bulletList', content: [item({ type: 'paragraph' }, steps(1, 10))] })
    expectRoundTrip(tenSteps)
    expect(richTextToMarkdown(tenSteps).split('\n').slice(-2)).toEqual(['  9.  step 8', '  10. step 9'])
    expectRoundTrip(doc({ type: 'orderedList', attrs: { start: 99 }, content: [item({ type: 'paragraph' }, steps(99, 2)), item(para(text('z')))] }))
    expectRoundTrip(doc(steps(8, 5)))
  })

  it('handles runs of # and digits at the start of a line', () => {
    expectRoundTrip(doc(para(text('#'.repeat(26) + 'x'), text('y', [bold]))))
    expectRoundTrip(doc(para(text('####### a'), text('b', [bold]))))
    expectRoundTrip(doc(para(text('#######'), text('x', [bold]))))
    expectRoundTrip(doc(para(text('1234567890. x'), text('y', [italic]))))
    expect(markdownToRichText('####### x')).toEqual({ ok: true, doc: doc(para(text('####### x'))) })
  })

  it('escapes a ! before a link, even after an escaped backslash', () => {
    expectRoundTrip(doc(para(text('Wow!'), text('link', [link('/x')]))))
    expectRoundTrip(doc(para(text('a\\!'), text('link', [link('/x')]))))
    expectRoundTrip(doc(para(text('!'), text('link', [link('/x')]))))
  })

  it('round-trips alt text with markdown characters and an empty list item', () => {
    expectRoundTrip(doc(para({ type: 'image', attrs: { media: sha, alt: 'a *b* [c] &amp;' } })))
    expectRoundTrip(doc({ type: 'bulletList', content: [item({ type: 'paragraph' }), item(para(text('b')))] }))
    expectRoundTrip(doc({ type: 'orderedList', attrs: { start: 0 }, content: [item(para(text('zero')))] }))
  })
})

describe('markdownToRichText', () => {
  it('turns a soft line break into a space', () => {
    expect(markdownToRichText('line one\nline two')).toEqual({ ok: true, doc: doc(para(text('line one line two'))) })
  })

  it('reads an empty string as an empty doc', () => {
    expect(markdownToRichText('')).toEqual({ ok: true, doc: { type: 'doc', content: [] } })
  })

  it('reads internal links, images and a loose list', () => {
    const result = markdownToRichText(`[About](inlay:document/${uuid}) ![](inlay:media/${sha})\n\n- a\n\n- b`)
    expect(result).toEqual({
      ok: true,
      doc: doc(
        para(text('About', [{ type: 'link', attrs: { document: uuid } }]), text(' '), { type: 'image', attrs: { media: sha } }),
        { type: 'bulletList', content: [item(para(text('a'))), item(para(text('b')))] },
      ),
    })
  })

  it('rejects rules and indented code', () => {
    expect(problems('---')).toMatchObject([{ code: 'unsupported', line: 1 }])
    expect(problems('a\n\n    code')).toMatchObject([{ code: 'unsupported', line: 3 }])
  })

  it('rejects HTML, tables and strikethrough instead of keeping them as literal text', () => {
    const html = problems('Hi <b>there</b>.')
    expect(html).toMatchObject([{ code: 'unsupported', line: 1 }])
    expect(html[0]?.message).toContain(t('richtext.feature.html'))
    expect(problems('Intro\n\n<div>x</div>')).toMatchObject([{ code: 'unsupported', line: 3 }])
    const table = problems('| a | b |\n|---|---|\n| 1 | 2 |', { features: ['bold'] })
    expect(table).toMatchObject([{ code: 'not_allowed', line: 1 }])
    expect(table[0]?.message).toContain(t('richtext.feature.table'))
    const strike = problems('~~gone~~')
    expect(strike).toMatchObject([{ code: 'unsupported', line: 1 }])
    expect(strike[0]?.message).toContain(t('richtext.feature.strike'))
  })

  it('accepts the escaped forms that reading rich text back gives', () => {
    const d = doc(para(text('Hi <b>there</b> ~~not struck~~ | a | b |')))
    const { markdown, back } = roundTrip(d)
    expect(back).toEqual({ ok: true, doc: d })
    expect(markdown).not.toBe('Hi <b>there</b> ~~not struck~~ | a | b |')
  })

  it('rejects a heading level the field does not allow, listing the allowed levels', () => {
    const found = problems('# Title')
    expect(found).toMatchObject([{ code: 'heading_level', line: 1 }])
    expect(found[0]?.message).toContain('2, 3, 4')
  })

  it('rejects images that are not from the media library', () => {
    expect(problems('![x](https://img.example/x.png)')).toMatchObject([{ code: 'image_source', line: 1 }])
    expect(problems('![x](inlay:media/abc)')).toMatchObject([{ code: 'image_source', line: 1 }])
  })

  it('rejects unsafe link URLs', () => {
    expect(problems('[x](javascript:alert(1))')).toMatchObject([{ code: 'link_url', line: 1 }])
    expect(problems('[x](inlay:document/nope)')).toMatchObject([{ code: 'link_url', line: 1 }])
  })

  it('rejects features the field does not allow', () => {
    const found = problems('- item', { features: ['bold', 'italic'] })
    expect(found).toMatchObject([{ code: 'not_allowed', line: 1 }])
    expect(found[0]?.message).toMatch(/list/)
    expect(problems('a\n**b**', { features: ['italic'] })).toMatchObject([{ code: 'not_allowed', line: 2 }])
    expect(problems('## x', { features: ['bold'] })).toMatchObject([{ code: 'not_allowed', line: 1 }])
  })

  it('reports every problem, each on its own line', () => {
    const found = problems('# Title\n\nSome ~~old~~ here\nand ![x](https://img.example/x.png)')
    expect(found).toMatchObject([
      { code: 'heading_level', line: 1 },
      { code: 'unsupported', line: 3 },
      { code: 'image_source', line: 4 },
    ])
  })

  it('rejects images and line breaks inside headings', () => {
    expect(problems(`## a ![x](inlay:media/${sha})`)).toMatchObject([{ code: 'unsupported', line: 1 }])
    expect(problems('a\\\nb\n---')).toMatchObject([{ code: 'unsupported', line: 1 }])
  })

  it('rejects link addresses with control characters', () => {
    expect(problems('[x](<a\tb>)')).toMatchObject([{ code: 'link_url', line: 1 }])
  })

  it('reports link reference definitions no link uses, rather than dropping them', () => {
    const found = problems('Intro\n\n[1]: https://example.com\n\nOutro')
    expect(found).toMatchObject([{ code: 'unsupported', line: 3 }])
    expect(found[0]?.message).toMatch(/^Line 3: "\[1\]: https:\/\/example.com"/)
    expect(problems('> [x]: /a')).toMatchObject([{ code: 'unsupported', line: 1 }])
    expect(problems('[1]: /a\n[1]: /b\n\n[1]')).toMatchObject([{ code: 'unsupported', line: 2 }])
    expect(markdownToRichText('See [it][1].\n\n[1]: https://example.com')).toEqual({
      ok: true,
      doc: doc(para(text('See '), text('it', [link('https://example.com')]), text('.'))),
    })
    expect(problems('[x][1]\n\n[1]: javascript:alert(1)')).toMatchObject([{ code: 'link_url', line: 1 }])
  })

  it('reports quotes and lists nested too deeply, rather than dropping what follows', () => {
    const quotes = problems('>'.repeat(25) + ' x\n\nafter')
    expect(quotes).toMatchObject([{ code: 'unsupported', line: 1 }])
    expect(quotes[0]?.message).toMatch(/nested too deeply/)
    const list = Array.from({ length: 10 }, (_, i) => '  '.repeat(i) + '- x').join('\n') + '\n\nafter'
    expect(problems(list)).toMatchObject([{ code: 'unsupported', line: 10 }])
    expect(markdownToRichText('>'.repeat(19) + ' x').ok).toBe(true)
  })

  it('rejects link and image titles rather than dropping them', () => {
    expect(problems('[x](/a "Title")')).toMatchObject([{ code: 'unsupported', line: 1 }])
  })

  it('rejects link addresses with control characters, even absolute ones', () => {
    expect(problems('[x](<https://example.com/a\tb>)')).toMatchObject([{ code: 'link_url', line: 1 }])
  })

  it('writes plain-language messages', () => {
    for (const p of problems('```\nx\n```\n\n# T\n\n[x](javascript:x)', { features: ['bold', 'link'] })) {
      expect(p.message).toMatch(/^Line \d+: /)
      expect(p.message).not.toMatch(/richtext\.|undefined|\{/)
    }
  })

  it('lists image targets with their lines, not ones in code', () => {
    expect(markdownImages('a `![a](./x.png)`\n\n![b](y.png)\n\n\\![c](z.png)')).toEqual([{ src: 'y.png', line: 3 }])
    expect(markdownImages('![a](<images/my chart (1).png>)\nand\n![b](b.png) ![c](c.png)')).toEqual([
      { src: 'images/my chart (1).png', line: 1 },
      { src: 'b.png', line: 3 },
      { src: 'c.png', line: 3 },
    ])
    expect(markdownImages('```\n![a](x.png)\n```\n\n    ![b](y.png)')).toEqual([])
  })

  it('reads an image target named in images as that library image', () => {
    const images = new Map([['images/team.png', sha]])
    expect(markdownToRichText('Hi\n\n![Team](images/team.png)', undefined, { images })).toEqual({
      ok: true,
      doc: doc(para(text('Hi')), para({ type: 'image', attrs: { media: sha, alt: 'Team' } })),
    })
    expect(problems('![x](other.png)')).toMatchObject([{ code: 'image_source', line: 1 }])
    expect(markdownToRichText('![x](other.png)', undefined, { images })).toMatchObject({ ok: false, problems: [{ code: 'image_source', line: 1 }] })
  })

  it.each(['**', '[', '![]()', '\\', '> ', '1.', '- ', '>', '[](<>)', '![', '*a **b* c**', '\u0000', '- # x', '- - x', '[a]:', '>'.repeat(200), '- '.repeat(100) + 'x'])(
    'never throws on %j',
    (s) => {
      expect(() => markdownToRichText(s)).not.toThrow()
    },
  )
})

describe('tables', () => {
  const cell = (type: 'tableHeader' | 'tableCell', ...content: unknown[]) => ({
    type,
    content: [content.length > 0 ? para(...content) : { type: 'paragraph' }],
  })
  const th = (...content: unknown[]) => cell('tableHeader', ...content)
  const td = (...content: unknown[]) => cell('tableCell', ...content)
  const row = (...cells: unknown[]) => ({ type: 'tableRow', content: cells })
  const tableOf = (...rows: unknown[]) => ({ type: 'table', content: rows })

  it('round-trips a table with bold, italic and links in cells', () => {
    const md = '| Plan | Price |\n| --- | --- |\n| **Pro** | [Buy](https://example.com/buy) |\n| *Lite* | free |\n'
    const read = markdownToRichText(md)
    expect(read).toEqual({
      ok: true,
      doc: doc(
        tableOf(
          row(th(text('Plan')), th(text('Price'))),
          row(td(text('Pro', [bold])), td(text('Buy', [link('https://example.com/buy')]))),
          row(td(text('Lite', [italic])), td(text('free'))),
        ),
      ),
    })
    if (!read.ok) return
    expect(richTextToMarkdown(read.doc)).toBe(md)
  })

  it('round-trips a table between paragraphs', () => {
    const md = 'Intro\n\n| a |\n| --- |\n| 1 |\n\nOutro'
    const read = markdownToRichText(md)
    expect(read.ok && richTextToMarkdown(read.doc)).toBe(md)
  })

  it('escapes a pipe and keeps backslashes in cells and in link URLs', () => {
    const d = doc(
      tableOf(
        row(th(text('a | b \\ c')), th(text('q', [link('https://x.test/?q=a|b')]))),
        row(td(text('x\\|y')), td(text('w', [link('https://x.test/a\\|b')]))),
      ),
    )
    const markdown = richTextToMarkdown(d)
    expect(markdown).toContain('| a \\| b \\\\ c |')
    expect(markdown).toContain('(https://x.test/?q=a\\|b)')
    expect(markdownToRichText(markdown), markdown).toEqual({ ok: true, doc: d })
  })

  it('keeps text with pipes and a line break a paragraph, not a table', () => {
    for (const second of [':-- | --', '|---|---|', ':-:', '| - |']) {
      expectRoundTrip(doc(para(text('a | b'), { type: 'hardBreak' }, text(second))))
    }
  })

  it('pads short rows and trims long ones', () => {
    expect(markdownToRichText('| a | b |\n| - | - |\n| 1 |\n| 1 | 2 | 3 |\n')).toEqual({
      ok: true,
      doc: doc(
        tableOf(row(th(text('a')), th(text('b'))), row(td(text('1')), td()), row(td(text('1')), td(text('2')))),
      ),
    })
  })

  it('accepts and drops alignment markers', () => {
    expect(markdownToRichText('| a |\n| :-: |\n| 1 |\n')).toEqual(markdownToRichText('| a |\n| --- |\n| 1 |\n'))
    expect(markdownToRichText('| a |\n| :-: |\n| 1 |\n')).toEqual({
      ok: true,
      doc: doc(tableOf(row(th(text('a'))), row(td(text('1'))))),
    })
  })

  it('round-trips a header-only table', () => {
    const md = '| a | b |\n| --- | --- |\n'
    const read = markdownToRichText(md)
    expect(read).toEqual({ ok: true, doc: doc(tableOf(row(th(text('a')), th(text('b'))))) })
    expect(read.ok && richTextToMarkdown(read.doc)).toBe(md)
  })

  it('round-trips random tables with pipes, backslashes and marks in cells and link URLs', () => {
    let seed = 3
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!
    const texts = ['a', '|', '\\', '\\|', ':', '-', '---', '*', '_', '[', ']', '(', '<', '&amp;', '`', '#', '>', '1.', '!', 'x y', 'b |a| c', '||']
    const markSets = [[], [], [bold], [italic], [link('/a|b\\|c')], [link('https://x.test/(a b)|c'), bold], [code], [link('/c'), code]]
    let checked = 0
    for (let n = 0; n < 1500; n++) {
      const inline = () =>
        Array.from({ length: Math.floor(random() * 4) }, () => text(pick(texts) + pick(texts), pick(markSets)))
      const width = 1 + Math.floor(random() * 3)
      const rows = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
        row(...Array.from({ length: width }, () => td(...inline()))),
      )
      const parsed = parseRichText({ type: 'doc', content: [para(...inline()), tableOf(...rows)] }, DEFAULT_RICH_TEXT)
      if (!parsed.ok) continue
      checked++
      expectRoundTrip(parsed.doc)
    }
    expect(checked).toBeGreaterThan(1000)
  })

  it('round-trips empty cells', () => {
    expectRoundTrip(doc(tableOf(row(th(), th(text('b'))), row(td(), td()))))
  })

  it('refuses an image or a line break in a cell with the line', () => {
    expect(problems(`| a |\n| --- |\n| ![x](inlay:media/${sha}) |\n`)).toEqual([
      {
        code: 'unsupported',
        line: 3,
        message: t('richtext.tableCell', { line: 3, feature: t('richtext.feature.image') }),
      },
    ])
  })

  it('refuses a table inside a list or a quote', () => {
    const inList = problems('- item\n\n  | a |\n  | - |\n')
    expect(inList).toEqual([{ code: 'unsupported', line: 3, message: t('richtext.tableNested', { line: 3 }) }])
    expect(problems('> | a |\n> | - |\n')).toMatchObject([{ code: 'unsupported', line: 1 }])
  })

  it('refuses a table where the field leaves tables out', () => {
    const found = problems('| a |\n| - |\n', { features: ['bold'] })
    expect(found).toMatchObject([{ code: 'not_allowed', line: 1 }])
    expect(found[0]?.message).toContain(t('richtext.feature.table'))
  })

  it('still refuses strikethrough and HTML in cells', () => {
    const strike = problems('| a |\n| - |\n| ~~x~~ |\n')
    expect(strike).toMatchObject([{ code: 'unsupported', line: 3 }])
    expect(strike[0]?.message).toContain(t('richtext.feature.strike'))
    const html = problems('| a |\n| - |\n| <b>x</b> |\n')
    expect(html).toMatchObject([{ code: 'unsupported', line: 3 }])
    expect(html[0]?.message).toContain(t('richtext.feature.html'))
  })
})

describe('inline code', () => {
  const awkward = ['a', 'npm test', '`', '``', 'a`b', '`a', 'a`', 'a``b`c', ' a ', ' a', 'a ', ' ', '  ', '*a*', '**', '_x_', '<b>', '&amp;', '&#32;', '\\', 'a\\', '\\`', '[x](y)', ']', '|', 'a|b', '\\|', '#', '1.', '- ', '> ', '!', '~~x~~', '\uE000', 'x\uE001\uE002y', '\uE003']
  const heading = (...content: unknown[]) => ({ type: 'heading', attrs: { level: 2 }, content })
  const cells = (...content: unknown[]) => ({
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [para(...content)] }] }],
  })

  it('reads text between backticks as code', () => {
    expect(markdownToRichText('Run `npm test` now')).toEqual({
      ok: true,
      doc: doc(para(text('Run '), text('npm test', [code]), text(' now'))),
    })
    expect(markdownToRichText('`` a`b ``')).toEqual({ ok: true, doc: doc(para(text('a`b', [code]))) })
  })

  it('writes code between backticks, and a link around it', () => {
    expect(richTextToMarkdown(doc(para(text('Run '), text('npm test', [code]), text(' now'))))).toBe('Run `npm test` now')
    expect(richTextToMarkdown(doc(para(text('a`b', [code]))))).toBe('``a`b``')
    expect(richTextToMarkdown(doc(para(text('`a', [code]))))).toBe('`` `a ``')
    expect(richTextToMarkdown(doc(para(text(' a ', [code]))))).toBe('`  a  `')
    expect(richTextToMarkdown(doc(para(text('x', [link('/a'), code]))))).toBe('[`x`](/a)')
  })

  it.each(awkward)('round-trips the code %j wherever code can go', (s) => {
    expectRoundTrip(doc(para(text(s, [code]))))
    expectRoundTrip(doc(para(text('a'), text(s, [code]), text('b'))))
    expectRoundTrip(doc(para(text('a', [bold]), text(s, [code]), text('b', [italic]))))
    expectRoundTrip(doc(para(text('see '), text(s, [link('/x'), code]), text('!', [link('/x')]))))
    expectRoundTrip(doc(para(text('wow!'), text(s, [link('/x'), code]))))
    expectRoundTrip(doc(para(text('a'), { type: 'hardBreak' }, text(s, [code]))))
    expectRoundTrip(doc(heading(text('C '), text(s, [code]))))
    expectRoundTrip(doc(heading(text(s, [code]), text('#'))))
    expectRoundTrip(doc({ type: 'bulletList', content: [item(para(text(s, [code])))] }))
    expectRoundTrip(doc({ type: 'blockquote', content: [para(text(s, [code]))] }))
    expectRoundTrip(doc(cells(text(s, [code]))))
    expectRoundTrip(doc(cells(text('x|'), text(s, [code]), text('|y', [bold]))))
  })

  it('round-trips code next to code with another link', () => {
    expectRoundTrip(doc(para(text('a', [link('/a'), code]), text('b', [link('/b'), code]))))
    expectRoundTrip(doc(para(text('a', [code]), text('b', [link('/b'), code]))))
  })

  it('refuses code inside bold or italic text, naming the line', () => {
    expect(problems('**a `b` c**')).toEqual([{ code: 'unsupported', line: 1, message: t('richtext.codeEmphasis', { line: 1 }) }])
    expect(problems('x\n\n*`b`*')).toEqual([{ code: 'unsupported', line: 3, message: t('richtext.codeEmphasis', { line: 3 }) }])
    expect(problems('| a |\n| - |\n| _`b`_ |\n')).toMatchObject([{ code: 'unsupported', line: 3 }])
    expect(markdownToRichText('**a** `b` *c* [`d`](/d)').ok).toBe(true)
  })

  it('refuses code where the field leaves it out', () => {
    const found = problems('`x`', { features: ['bold'] })
    expect(found).toMatchObject([{ code: 'not_allowed', line: 1 }])
    expect(found[0]?.message).toContain(t('richtext.feature.code'))
  })
})

describe('code blocks', () => {
  const codeBlock = (code: string, language?: string) =>
    language === undefined ? { type: 'codeBlock', content: [text(code)] } : { type: 'codeBlock', attrs: { language }, content: [text(code)] }
  const quote = (...content: unknown[]) => ({ type: 'blockquote', content })
  const bullets = (...content: unknown[]) => ({ type: 'bulletList', content })

  it('reads a fence as a code block, with or without a language', () => {
    expect(markdownToRichText('```ts\nconst a = 1\n```')).toEqual({ ok: true, doc: doc(codeBlock('const a = 1', 'ts')) })
    expect(markdownToRichText('```\nconst a = 1\n```')).toEqual({ ok: true, doc: doc(codeBlock('const a = 1')) })
    expect(markdownToRichText('~~~ts\nconst a = 1\n~~~')).toEqual({ ok: true, doc: doc(codeBlock('const a = 1', 'ts')) })
  })

  it('writes a fence with the language after the backticks', () => {
    expect(richTextToMarkdown(doc(codeBlock('const a = 1', 'ts')))).toBe('```ts\nconst a = 1\n```')
  })

  it.each([
    ['simple code with a language', [codeBlock('const a = 1', 'ts')]],
    ['blank lines, leading spaces and tabs', [codeBlock('a\n\n  b\n\tc\n    d\n', 'py')]],
    ['backtick runs', [codeBlock('```\nx ```` y\n`')]],
    ['Markdown and HTML syntax', [codeBlock('`` *a* _b_ <b> &amp; \\ ~~x~~ # [x](y) ![i](j)\n> q\n- l\n1. n\n---')]],
    ['stand-in characters', [codeBlock('\uE000a\uE001 \uE002b\uE003 \uE004')]],
    ['a quote', [quote(para(text('Run:')), codeBlock('a\n\n  b\n\tc', 'sh'))]],
    ['a quote, first', [quote(codeBlock('a\n\n  b'))]],
    ['a list item, second', [bullets(item(para(text('Run:')), codeBlock('a\n\n  b', 'ts')), item(para(text('next'))))]],
    ['a list item, first', [bullets(item(para(), codeBlock('  a\n\nb', 'ts')), item(para(text('next'))))]],
    ['a nested list in a quote', [quote(bullets(item(para(text('x')), bullets(item(para(), codeBlock('  a\n\n\tb'))))))]],
    ['an ordered list', [{ type: 'orderedList', attrs: { start: 9 }, content: [item(para(text('a')), codeBlock(' x\n\ny', 'C#'))] }]],
    ['between two paragraphs', [para(text('Before')), codeBlock('x', 'c++'), para(text('After'))]],
    ['two in a row', [codeBlock('a'), codeBlock('b', 'objective-c')]],
  ])('round-trips %s', (_, content) => {
    expectRoundTrip(doc(...content))
  })

  it('writes a fence longer than the longest run of backticks', () => {
    expect(richTextToMarkdown(doc(codeBlock('```\nx ```` y')))).toBe('`````\n```\nx ```` y\n`````')
  })

  it('puts the container prefix on every line', () => {
    expect(richTextToMarkdown(doc(quote(codeBlock('a\n\n b'))))).toBe('> ```\n> a\n> \n>  b\n> ```')
    expect(richTextToMarkdown(doc(bullets(item(para(), codeBlock(' a\n\nb', 'ts')))))).toBe('- ```ts\n   a\n  \n  b\n  ```')
  })

  it('refuses a fence whose info is not one language, naming its line', () => {
    expect(problems('Intro\n\n```ts title="app.ts"\nx\n```')).toEqual([
      { code: 'unsupported', line: 3, message: t('richtext.codeLanguage', { line: 3, language: 'ts title="app.ts"' }) },
    ])
    expect(problems('~~~a b\nx\n~~~')).toMatchObject([{ code: 'unsupported', line: 1 }])
  })

  it('refuses a fence that is never closed, on its opening line', () => {
    const unclosed = (line: number) => [{ code: 'unsupported', line, message: t('richtext.unclosedCode', { line }) }]
    expect(problems('```ts\nunclosed\n')).toEqual(unclosed(1))
    expect(problems('Intro\n\n~~~\na\nb')).toEqual(unclosed(3))
    expect(problems('```')).toEqual(unclosed(1))
    expect(problems('Intro\n\n> ```\n> a\n\nafter')).toEqual(unclosed(3))
    expect(problems('- ```\n  a\n- b')).toEqual(unclosed(1))
    expect(problems('- x\n\n  ```\n  a\n\nnot')).toEqual(unclosed(3))
  })

  it('accepts a fence closed by the same or a longer run', () => {
    expect(markdownToRichText('```\na\n`````\n\nafter')).toEqual({ ok: true, doc: doc(codeBlock('a'), para(text('after'))) })
    expect(markdownToRichText('~~~\na\n~~~~')).toEqual({ ok: true, doc: doc(codeBlock('a')) })
    expect(markdownToRichText('```\n```').ok).toBe(true)
    expect(markdownToRichText('> ```\n> a\n> ```\n\nafter')).toEqual({ ok: true, doc: doc(quote(codeBlock('a')), para(text('after'))) })
    expect(markdownToRichText('- ```\n  a\n  ```\n- b')).toEqual({
      ok: true,
      doc: doc(bullets(item(para(), codeBlock('a')), item(para(text('b'))))),
    })
  })

  it('refuses indented code, naming its line', () => {
    expect(problems('    indented code')).toEqual([{ code: 'unsupported', line: 1, message: t('richtext.indentedCode', { line: 1 }) }])
  })

  it('refuses a fence where the field leaves code blocks out', () => {
    expect(problems('a\n\n```\nx\n```', { features: ['bold'] })).toEqual([
      { code: 'not_allowed', line: 3, message: t('richtext.notAllowed', { line: 3, feature: t('richtext.feature.codeBlock') }) },
    ])
    expect(markdownToRichText('```\nx\n```', { features: ['codeBlock'] }).ok).toBe(true)
  })

  it('keeps HTML and strikethrough inside a fence as code', () => {
    expect(markdownToRichText('```html\n<b>x</b> ~~y~~\n<div>\n```')).toEqual({
      ok: true,
      doc: doc(codeBlock('<b>x</b> ~~y~~\n<div>', 'html')),
    })
  })
})

describe('markdown fuzz', () => {
  const pieces = ['a', 'b ', ' ', '\n', '\n\n', '*', '**', '_', '[', ']', '(', ')', '!', '#', '## ', '> ', '- ', '1. ', '3) ', '\\', '&amp;', '<', '>', '`', '   ', '\t', 'x_y', '=', '---', `![p](inlay:media/${sha})`, '[l](/x)', '  \n', '\n  - ', '\n  3. ', '\n   1) ', '"', '[1]: /y\n', '[1]']

  it('never throws, and anything it accepts round-trips', () => {
    let seed = 42
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    for (let n = 0; n < 3000; n++) {
      const length = 1 + Math.floor(random() * 12)
      let input = ''
      for (let i = 0; i < length; i++) input += pieces[Math.floor(random() * pieces.length)]
      const first = markdownToRichText(input)
      if (!first.ok) continue
      const markdown = richTextToMarkdown(first.doc)
      expect(markdownToRichText(markdown), JSON.stringify({ input, markdown })).toEqual(first)
    }
  })

  /** Random docs from a fixed seed; `loose` adds line breaks and spaces at the ends of text. */
  function randomDocs(count: number, loose: boolean): RichTextDoc[] {
    let seed = loose ? 11 : 7
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!
    const texts = ['a', 'b c', '"', '(', ')', '.', '*', '_', 'x_y', '!', '[', ']', '&amp;', '1.', '#', '\\', '<', 'é', '🎉', ',', '`', '-', '&', ';', '9']
    if (loose) texts.push(' ', ' x ', 'a  b')
    const markSets = [[], [], [bold], [italic], [bold, italic], [link('/a')], [link('/a'), italic], [link('/b'), bold], [code], [link('/a'), code]]
    const inline = () =>
      Array.from({ length: 1 + Math.floor(random() * 6) }, () => {
        const marks = pick(markSets)
        if (loose && random() < 0.08) return { type: 'hardBreak', marks }
        return text(pick(texts) + (random() < 0.5 ? pick(texts) : ''), marks)
      })
    const block = (depth: number): unknown => {
      const k = random()
      if (depth < 3 && k < 0.15) return { type: 'blockquote', content: [block(depth + 1)] }
      if (depth < 3 && k < 0.35) {
        const items = Array.from({ length: 1 + Math.floor(random() * 2) }, () =>
          random() < 0.15 ? item({ type: 'paragraph' }) : item(para(...inline()), ...(random() < 0.5 ? [block(depth + 1)] : [])),
        )
        return random() < 0.5
          ? { type: 'bulletList', content: items }
          : { type: 'orderedList', attrs: { start: pick([0, 1, 2, 3]) }, content: items }
      }
      return para(...inline())
    }
    const docs: RichTextDoc[] = []
    while (docs.length < count) {
      const parsed = parseRichText({ type: 'doc', content: [block(0), block(0)] }, DEFAULT_RICH_TEXT)
      if (parsed.ok) docs.push(parsed.doc)
    }
    return docs
  }

  it('round-trips docs built as JSON, with marks next to punctuation and nested lists', () => {
    for (const d of randomDocs(2000, false)) expectRoundTrip(d)
  })

  it('keeps the text and the bold and italic on it with line breaks and spaces in the mix', () => {
    for (const d of randomDocs(2000, true)) {
      const { markdown, back } = roundTrip(d)
      expect(back.ok, markdown).toBe(true)
      if (!back.ok) continue
      expect(emphasis(back.doc), markdown).toEqual(emphasis(d))
    }
  })
})

/** Runs `f` and checks it took less than `ms`: far above the time it takes, far below the time a slowdown would. */
function fast<T>(ms: number, f: () => T): T {
  const start = performance.now()
  const result = f()
  expect(performance.now() - start).toBeLessThan(ms)
  return result
}

describe('large and awkward input', () => {
  it('writes long runs of # without backtracking', () => {
    for (const n of [40, 5000]) {
      const d = doc(para(text('#'.repeat(n) + 'x'), text('y', [bold])))
      expect(markdownToRichText(fast(1000, () => richTextToMarkdown(d)))).toEqual({ ok: true, doc: d })
    }
  })

  it('tracks many link reference definitions in linear time', () => {
    const markdown = Array.from({ length: 20000 }, (_, i) => `[d${i}]: /x`).join('\n') + '\n\nSee [it][d5].'
    const found = fast(2000, () => problems(markdown))
    expect(found).toHaveLength(19999)
    expect(found[0]).toMatchObject({ line: 1 })
  })

  it('writes many bold line breaks, links and long spaces in linear time', () => {
    const breaks = doc(para(text('a', [bold]), ...Array.from({ length: 20000 }, () => ({ type: 'hardBreak', marks: [bold] })), text('b', [bold])))
    expect(emphasis((markdownToRichText(fast(2000, () => richTextToMarkdown(breaks))) as { doc: RichTextDoc }).doc)).toEqual(['abold', 'bbold'])
    const links = doc(para(...Array.from({ length: 20000 }, (_, i) => text(`w${i}!`, i % 2 ? [link('/x')] : undefined))))
    expectRoundTripOf(fast(2000, () => richTextToMarkdown(links)), links)
    const spaces = doc(para(text('a' + ' '.repeat(200000) + 'b', [bold]), text('c')))
    expectRoundTripOf(fast(2000, () => richTextToMarkdown(spaces)), spaces)
    const bolds = doc(para(...Array.from({ length: 20000 }, (_, i) => text(`w${i} `, i % 2 ? [bold] : undefined))))
    const back = markdownToRichText(fast(3000, () => richTextToMarkdown(bolds)))
    expect(back.ok && emphasis(back.doc)).toEqual(emphasis(bolds))
    const paragraphs = doc(...Array.from({ length: 20000 }, (_, i) => para(text(`p${i} `), text('b', [bold]))))
    expectRoundTripOf(fast(3000, () => richTextToMarkdown(paragraphs)), paragraphs)
  })
})

function expectRoundTripOf(markdown: string, d: RichTextDoc) {
  expect(markdownToRichText(markdown)).toEqual({ ok: true, doc: d })
}
