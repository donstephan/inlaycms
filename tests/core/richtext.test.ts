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
