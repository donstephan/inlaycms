import { z } from 'zod'
import { diffData, formatDiff } from '../../src/core/content/diff.js'
import { validateContent } from '../../src/core/content/validate.js'
import { InlayError } from '../../src/core/errors.js'
import { f } from '../../src/core/fields/builtins.js'
import { isSafeUrl } from '../../src/core/fields/define.js'
import { buildRegistry } from '../../src/core/registry/registry.js'
import {
  DEFAULT_RICH_TEXT,
  parseRichText,
  richTextIsBlank,
  richTextRefs,
  richTextText,
  type RichTextDoc,
} from '../../src/core/richtext/schema.js'
import type { DocumentData } from '../../src/core/types.js'
import { articleSite } from '../fixtures/articles.js'
import { pdf } from '../fixtures/media.js'
import { makeCore } from '../helpers/core.js'

const uuid = '6f1c2b1e-8a3d-4b7e-9c2a-000000000001'
const sha = 'a'.repeat(64)

const para = (...content: unknown[]) => ({ type: 'paragraph', content })
const text = (s: string, marks?: unknown[]) => (marks ? { type: 'text', text: s, marks } : { type: 'text', text: s })
const doc = (...content: unknown[]) => ({ type: 'doc', content })

const parse = (value: unknown, opts = DEFAULT_RICH_TEXT) => parseRichText(value, opts)

const everything: RichTextDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Plain ' },
        { type: 'text', text: 'both', marks: [{ type: 'bold' }, { type: 'italic' }] },
        { type: 'text', text: ' site', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
        { type: 'text', text: ' page', marks: [{ type: 'link', attrs: { document: uuid } }, { type: 'bold' }] },
        { type: 'hardBreak' },
        { type: 'image', attrs: { media: sha, alt: 'A cat' } },
        { type: 'image', attrs: { media: sha } },
      ],
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph' }] },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
            {
              type: 'orderedList',
              attrs: { start: 3 },
              content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Three' }] }] }],
            },
          ],
        },
      ],
    },
    {
      type: 'orderedList',
      content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] }],
    },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted' }] }] },
  ],
}

describe('parseRichText', () => {
  it('keeps a doc that uses every feature as it is', () => {
    const result = parse(everything)
    expect(result).toEqual({ ok: true, doc: everything })
  })

  it('normalizes attrs, text and marks', () => {
    const link = { type: 'link', attrs: { href: '/about', target: '_blank', class: null } }
    expect(parse(doc(para(text('Go', [link]))))).toEqual({
      ok: true,
      doc: doc(para(text('Go', [{ type: 'link', attrs: { href: '/about' } }]))),
    })
    expect(parse(doc(para(text('a', [{ type: 'bold' }]), text('b', [{ type: 'bold' }]))))).toEqual({
      ok: true,
      doc: doc(para(text('ab', [{ type: 'bold' }]))),
    })
    expect(parse(doc(para(text('x', [{ type: 'italic' }, { type: 'bold' }]))))).toEqual({
      ok: true,
      doc: doc(para(text('x', [{ type: 'bold' }, { type: 'italic' }]))),
    })
    expect(parse(doc(para(text('a\nb'), text(''))))).toEqual({ ok: true, doc: doc(para(text('a b'))) })
    expect(parse(doc({ type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [para(text('x'))] }] })))
      .toEqual({ ok: true, doc: doc({ type: 'orderedList', content: [{ type: 'listItem', content: [para(text('x'))] }] }) })
  })

  it('drops empty paragraphs and emptied blockquotes', () => {
    expect(parse(doc(para(text('One')), { type: 'paragraph' }, para(text('Two'))))).toEqual({
      ok: true,
      doc: doc(para(text('One')), para(text('Two'))),
    })
    expect(parse(doc({ type: 'blockquote', content: [{ type: 'paragraph', content: [] }] }))).toEqual({
      ok: true,
      doc: doc(),
    })
  })

  it('turns a doc without content into an empty doc', () => {
    expect(parse({ type: 'doc' })).toEqual({ ok: true, doc: { type: 'doc', content: [] } })
  })

  it('rejects what the schema or the field does not allow', () => {
    const rejected = [
      doc({ type: 'codeBlock', content: [text('x')] }),
      doc({ type: 'heading', attrs: { level: 1 }, content: [text('H1')] }),
      doc(para(text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))),
      doc(para(text('x', [{ type: 'link', attrs: { href: '/a', document: uuid } }]))),
      doc(para(text('x', [{ type: 'link', attrs: {} }]))),
      doc(para({ type: 'image', attrs: { media: 'x' } })),
      doc({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [] }] }] }),
      doc(para(text('x', [{ type: 'underline' }]))),
      'not a doc',
      { type: 'paragraph' },
    ]
    for (const value of rejected) expect(parse(value)).toEqual({ ok: false })
    expect(parse(doc(para(text('x', [{ type: 'bold' }]))), { features: ['italic'], headings: [] })).toEqual({ ok: false })
  })

  it('keeps code, alone or linked, and refuses it with bold or italic', () => {
    const code = { type: 'code' }
    const linked = doc(para(text('x', [{ type: 'link', attrs: { href: '/a' } }, code])))
    expect(parse(linked)).toEqual({ ok: true, doc: linked })
    expect(parse(doc(para(text('x', [code, { type: 'link', attrs: { href: '/a' } }]))))).toEqual({ ok: true, doc: linked })
    expect(parse(doc(para(text('x', [{ type: 'bold' }, code]))))).toEqual({ ok: false })
    expect(parse(doc(para(text('x', [code, { type: 'italic' }]))))).toEqual({ ok: false })
    expect(parse(doc(para(text('x', [code]))), { features: ['bold'], headings: [] })).toEqual({ ok: false })
  })

  it('drops code from line breaks and images, which have no text to show it', () => {
    const code = { type: 'code' }
    const image = (marks: unknown[]) => ({ type: 'image', attrs: { media: sha }, marks })
    expect(parse(doc(para(text('a', [code]), { type: 'hardBreak', marks: [code] }, text('b', [code]), image([code]))))).toEqual({
      ok: true,
      doc: doc(para(text('a', [code]), { type: 'hardBreak' }, text('b', [code]), { type: 'image', attrs: { media: sha } })),
    })
  })

  it('rejects link addresses with control characters, but not with spaces', () => {
    const linked = (href: string) => parse(doc(para(text('x', [{ type: 'link', attrs: { href } }]))))
    for (const href of ['/a\nb', '/a\rb', '/a\tb', '/a\u0000b', '/a\u0001b', '/a\u007fb', 'https://example.com/\n']) {
      expect(linked(href), JSON.stringify(href)).toEqual({ ok: false })
    }
    expect(linked('/about us').ok).toBe(true)
  })

  it('drops line breaks at the end of a paragraph, and paragraphs left empty by that', () => {
    const br = { type: 'hardBreak' }
    expect(parse(doc(para(text('a'), br, br)))).toEqual({ ok: true, doc: doc(para(text('a'))) })
    expect(parse(doc(para(text('a')), para(br), para(text('b'))))).toEqual({ ok: true, doc: doc(para(text('a')), para(text('b'))) })
    expect(parse(doc({ type: 'bulletList', content: [{ type: 'listItem', content: [para(br), para(br)] }] }))).toEqual({
      ok: true,
      doc: doc({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }),
    })
    expect(parse(doc(para(text('a'), br, text('b'))))).toEqual({ ok: true, doc: doc(para(text('a'), br, text('b'))) })
  })
})

describe('isSafeUrl', () => {
  it('refuses control characters and addresses browsers read as another site', () => {
    expect(isSafeUrl('/about us')).toBe(true)
    expect(isSafeUrl('https://example.com/a\\b')).toBe(true)
    // Stored link fields with these must keep passing checks at boot; only rich text refuses them.
    expect(isSafeUrl('https://example.com/\n')).toBe(true)
    expect(isSafeUrl('mailto:a@example.com\t')).toBe(true)
    for (const url of ['/\t/evil.example', '/a\nb', '/\\evil.example', '//evil.example', 'java\tscript:alert(1)']) {
      expect(isSafeUrl(url), JSON.stringify(url)).toBe(false)
    }
  })
})

describe('rich text helpers', () => {
  it('reads the text, blankness and refs', () => {
    expect(richTextText(everything)).toBe('Title\nPlain both site page\n\n\nTwo\nThree\nOne\nQuoted')
    expect(richTextIsBlank(doc(para(text('  ')), para({ type: 'hardBreak' })) as RichTextDoc)).toBe(true)
    expect(richTextIsBlank(doc(para({ type: 'image', attrs: { media: sha } })) as RichTextDoc)).toBe(false)
    expect(richTextRefs(everything)).toEqual([
      { kind: 'document', id: uuid },
      { kind: 'media', id: sha },
    ])
  })
})

describe('f.richText', () => {
  const registry = buildRegistry(articleSite)
  const article = (fields: Record<string, unknown>): DocumentData => ({ slug: 'a', fields: { title: 'A', ...fields }, slots: {} })
  const issuesOf = (data: DocumentData, level: 'draft' | 'strict') => {
    const result = validateContent(registry, 'articles', data, level)
    return result.ok ? [] : result.issues
  }

  it('requires a non-blank body at strict level only', () => {
    expect(issuesOf(article({ body: doc(para(text('  '))) }), 'strict')).toMatchObject([
      { code: 'required', labels: ['Body'] },
    ])
    expect(issuesOf(article({}), 'strict')).toMatchObject([{ code: 'required', labels: ['Body'] }])
    expect(issuesOf(article({}), 'draft')).toEqual([])
    expect(issuesOf(article({ body: doc(para(text('  '))) }), 'draft')).toEqual([])
    expect(issuesOf(article({ body: doc(para(text('Hi'))) }), 'strict')).toEqual([])
  })

  it('stores the normalized doc', () => {
    const result = validateContent(registry, 'articles', article({ body: doc(para(text('a'), text('b'))) }), 'draft')
    expect(result.ok && result.data.fields.body).toEqual(doc(para(text('ab'))))
  })

  it('rejects features the field does not allow', () => {
    expect(issuesOf(article({ summary: doc({ type: 'heading', attrs: { level: 2 }, content: [text('H')] }) }), 'draft'))
      .toMatchObject([{ code: 'invalid', labels: ['Summary'] }])
  })

  it('rejects bad options when the field is defined', () => {
    const fail = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return e
      }
      return null
    }
    for (const fn of [
      () => f.richText({ label: 'X', headings: [7] }),
      () => f.richText({ label: 'X', headings: [0] }),
      () => f.richText({ label: 'X', features: ['strike' as never] }),
    ]) {
      const err = fail(fn)
      expect(err).toBeInstanceOf(InlayError)
      expect(err).toMatchObject({ code: 'definition' })
    }
  })

  it('formats a body change as text', () => {
    const before = article({ body: doc(para(text('Old')), para(text('text'))) })
    const after = article({ body: doc(para(text('New  text'))) })
    expect(formatDiff(diffData(registry, 'articles', before, after))).toEqual(['Body: “Old text” → “New text”'])
    const blank = article({ body: doc() })
    expect(formatDiff(diffData(registry, 'articles', blank, after))).toEqual(['Body: “empty” → “New text”'])
  })
})

describe('rich text references', () => {
  const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e)

  it('checks internal links and images like link and image fields', async () => {
    const s = await makeCore({ site: articleSite, media: true })
    await s.core.applyShippedContent()
    const notFound = (await s.core.findSingleton('notFound'))!
    const linked = doc(para(text('Missing', [{ type: 'link', attrs: { document: notFound.groupId } }])))
    const err = await fail(s.core.createEntry('articles', { fields: { title: 'A', body: linked } }, s.owner))
    expect(err).toMatchObject({ code: 'validation' })
    expect(err.details.issues).toMatchObject([{ code: 'not_routable', labels: ['Body'] }])

    const { media } = await s.core.addMedia({ data: pdf(), filename: 'doc.pdf' }, s.owner)
    const image = doc(para({ type: 'image', attrs: { media: media.id } }))
    const bad = await fail(s.core.createEntry('articles', { fields: { title: 'A', body: image } }, s.owner))
    expect(bad.details.issues).toMatchObject([{ code: 'wrong_media_type', labels: ['Body'] }])

    const body = doc(para(text('Bad', [{ type: 'underline' }])))
    const invalid = await fail(s.core.createEntry('articles', { fields: { title: 'A', body } }, s.owner))
    expect(invalid.details.issues).toMatchObject([{ code: 'invalid', labels: ['Body'] }])
  })
})

describe('tables', () => {
  const cell = (type: string, s: string) => ({
    type,
    content: [s === '' ? { type: 'paragraph' } : para(text(s))],
  })
  const row = (...cells: unknown[]) => ({ type: 'tableRow', content: cells })
  const table = (...rows: unknown[]) => ({ type: 'table', content: rows })

  it('promotes the first row to headers, makes body cells plain, pads and trims rows to the header width, and drops cell attrs', () => {
    const input = doc(
      table(
        row(
          { ...cell('tableCell', 'A'), attrs: { colspan: 1, rowspan: 1, colwidth: null } },
          cell('tableCell', 'B'),
        ),
        row(cell('tableHeader', '1')),
        row(cell('tableCell', 'x'), cell('tableCell', 'y'), cell('tableCell', 'z')),
      ),
    )
    expect(parse(input)).toEqual({
      ok: true,
      doc: doc(
        table(
          row(cell('tableHeader', 'A'), cell('tableHeader', 'B')),
          row(cell('tableCell', '1'), cell('tableCell', '')),
          row(cell('tableCell', 'x'), cell('tableCell', 'y')),
        ),
      ),
    })
  })

  it('removes a table with no rows or no columns', () => {
    expect(parse(doc({ type: 'table', content: [] }))).toEqual({ ok: true, doc: { type: 'doc', content: [] } })
    expect(parse(doc(table({ type: 'tableRow', content: [] })))).toEqual({
      ok: true,
      doc: { type: 'doc', content: [] },
    })
  })

  it('keeps an empty cell as one empty paragraph', () => {
    const parsed = parse(doc(table(row(cell('tableHeader', 'A')), row(cell('tableCell', '')))))
    expect(parsed).toEqual({
      ok: true,
      doc: doc(table(row(cell('tableHeader', 'A')), row(cell('tableCell', '')))),
    })
  })

  it("joins a cell's paragraphs into one, with a space between", () => {
    const joined = {
      type: 'tableHeader',
      content: [para(text('One', [{ type: 'bold' }])), para(text('two'))],
    }
    const parsed = parse(doc(table(row(joined))))
    expect(parsed).toEqual({
      ok: true,
      doc: doc(
        table(
          row({
            type: 'tableHeader',
            content: [para(text('One', [{ type: 'bold' }]), text(' two'))],
          }),
        ),
      ),
    })
    const empty = { type: 'tableHeader', content: [{ type: 'paragraph' }, para()] }
    expect(parse(doc(table(row(empty))))).toEqual({ ok: true, doc: doc(table(row(cell('tableHeader', '')))) })
  })

  it('refuses a table inside a list or a quote, and an image or line break in a cell', () => {
    const t = table(row(cell('tableHeader', 'A')))
    expect(parse(doc({ type: 'blockquote', content: [t] })).ok).toBe(false)
    expect(parse(doc({ type: 'bulletList', content: [{ type: 'listItem', content: [para(), t] }] })).ok).toBe(false)
    const image = { type: 'tableHeader', content: [para({ type: 'image', attrs: { media: sha } })] }
    expect(parse(doc(table(row(image)))).ok).toBe(false)
    const br = { type: 'tableHeader', content: [para(text('a'), { type: 'hardBreak' }, text('b'))] }
    expect(parse(doc(table(row(br)))).ok).toBe(false)
  })

  it('refuses a table when the field leaves tables out', () => {
    const t = doc(table(row(cell('tableHeader', 'A'))))
    expect(parse(t, { features: ['bold'], headings: [] }).ok).toBe(false)
  })

  it('reads table text with tabs between cells and newlines between rows, finds links in cells, and counts a table of empty cells as blank', () => {
    const link = { type: 'link', attrs: { document: uuid } }
    const parsed = parse(
      doc(
        para(text('Intro')),
        table(row(cell('tableHeader', 'A'), cell('tableHeader', 'B')), row(cell('tableCell', '1'), cell('tableCell', ''))),
      ),
    )
    if (!parsed.ok) throw new Error('invalid')
    expect(richTextText(parsed.doc)).toBe('Intro\nA\tB\n1\t')

    const linked = parse(doc(table(row({ type: 'tableHeader', content: [para(text('L', [link]))] }))))
    if (!linked.ok) throw new Error('invalid')
    expect(richTextRefs(linked.doc)).toContainEqual({ kind: 'document', id: uuid })

    const blank = parse(doc(table(row(cell('tableHeader', ''), cell('tableHeader', '')))))
    if (!blank.ok) throw new Error('invalid')
    expect(richTextIsBlank(blank.doc)).toBe(true)
  })
})
