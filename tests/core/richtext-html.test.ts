import { raw } from '../../src/jsx/html.js'
import { richTextHeadings } from '../../src/core/richtext/headings.js'
import { richTextToHtml, type CodeHighlighter } from '../../src/core/richtext/html.js'
import { DEFAULT_RICH_TEXT, parseRichText, type RichTextDoc } from '../../src/core/richtext/schema.js'

const uuid = '6f1c2b1e-8a3d-4b7e-9c2a-000000000001'
const sha = 'ab'.repeat(32)

const para = (...content: unknown[]) => ({ type: 'paragraph', content })
const text = (s: string, marks?: unknown[]) => (marks ? { type: 'text', text: s, marks } : { type: 'text', text: s })
const item = (...content: unknown[]) => ({ type: 'listItem', content })
const bold = { type: 'bold' }
const italic = { type: 'italic' }
const link = (href: string) => ({ type: 'link', attrs: { href } })
const internal = { type: 'link', attrs: { document: uuid } }

function doc(...content: unknown[]): RichTextDoc {
  const parsed = parseRichText({ type: 'doc', content }, DEFAULT_RICH_TEXT)
  if (!parsed.ok) throw new Error('test doc is not valid')
  return parsed.doc
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
    text('About', [internal]),
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

const resolve = {
  link: (id: string) => (id === uuid ? '/about' : null),
  image: (id: string, alt: string | undefined) =>
    id === sha
      ? { src: `/media/${id}/960.webp`, srcset: `/media/${id}/320.webp 320w`, alt: alt ?? 'Default', width: 800, height: 400 }
      : null,
}

describe('richTextToHtml', () => {
  it('renders every feature', () => {
    expect(richTextToHtml(full, resolve)).toBe(
      [
        '<h2>Heading</h2>',
        '<p>Some <strong>bold</strong> and <em>italic</em> text with a <a href="https://example.com">link</a> and <a href="/about">About</a>.</p>',
        '<ul><li><p>One</p></li><li><p>Two</p><ul><li><p>Nested</p></li></ul></li></ul>',
        '<ol start="3"><li><p>Three</p></li><li><p>Four</p></li></ol>',
        '<blockquote><p>Quoted</p></blockquote>',
        '<p>Line one<br>line two</p>',
        `<p><img src="/media/${sha}/960.webp" srcset="/media/${sha}/320.webp 320w" alt="A photo" width="800" height="400" loading="lazy"></p>`,
      ].join(''),
    )
  })

  it('renders code, inside a link, with its text escaped', () => {
    const code = { type: 'code' }
    const d = doc(para(text('Run '), text('<npm> & test', [code]), text(' or '), text('x', [link('/x'), code]), text('y', [link('/x')])))
    expect(richTextToHtml(d, resolve)).toBe('<p>Run <code>&lt;npm&gt; &amp; test</code> or <a href="/x"><code>x</code>y</a></p>')
  })

  it('keeps marks open across adjacent text', () => {
    const d = doc(para(text('a', [link('/x')]), text('b', [link('/x'), bold]), text('c', [bold])))
    expect(richTextToHtml(d, resolve)).toBe('<p><a href="/x">a<strong>b</strong></a><strong>c</strong></p>')
  })

  it('renders an unresolved internal link as its text', () => {
    const d = doc(para(text('Gone', [internal, bold]), text(' here')))
    expect(richTextToHtml(d, { ...resolve, link: () => null })).toBe('<p><strong>Gone</strong> here</p>')
  })

  it('leaves out a missing image and the attributes without a value', () => {
    const d = doc(para(text('Before'), { type: 'image', attrs: { media: 'cd'.repeat(32) } }))
    expect(richTextToHtml(d, resolve)).toBe('<p>Before</p>')
    const bare = doc(para({ type: 'image', attrs: { media: sha } }))
    const image = () => ({ src: '/media/x', srcset: '', alt: '', width: null, height: null })
    expect(richTextToHtml(bare, { ...resolve, image })).toBe('<p><img src="/media/x" alt="" loading="lazy"></p>')
  })

  it('escapes text and attributes', () => {
    const d = doc(
      para(text('<x> & "y"', [link('https://example.com/?a=1&b="2"')])),
      para({ type: 'image', attrs: { media: sha, alt: '"><script>' } }),
    )
    expect(richTextToHtml(d, resolve)).toBe(
      '<p><a href="https://example.com/?a=1&amp;b=&quot;2&quot;">&lt;x&gt; &amp; &quot;y&quot;</a></p>' +
        `<p><img src="/media/${sha}/960.webp" srcset="/media/${sha}/320.webp 320w" alt="&quot;&gt;&lt;script&gt;" width="800" height="400" loading="lazy"></p>`,
    )
  })
})

describe('richTextToHtml tables', () => {
  const cell = (type: string, ...content: unknown[]) => ({ type, content: [para(...content)] })
  const row = (...cells: unknown[]) => ({ type: 'tableRow', content: cells })

  it('renders a table with a head and a body, cells inline', () => {
    const d = doc({
      type: 'table',
      content: [
        row(cell('tableHeader', text('A')), cell('tableHeader', text('B', [bold]))),
        row(cell('tableCell', text('1', [link('/x')])), { type: 'tableCell', content: [{ type: 'paragraph' }] }),
      ],
    })
    expect(richTextToHtml(d, resolve)).toBe(
      '<table><thead><tr><th>A</th><th><strong>B</strong></th></tr></thead><tbody><tr><td><a href="/x">1</a></td><td></td></tr></tbody></table>',
    )
  })

  it('renders a header-only table without tbody', () => {
    const d = doc({ type: 'table', content: [row(cell('tableHeader', text('A')))] })
    expect(richTextToHtml(d, resolve)).toBe('<table><thead><tr><th>A</th></tr></thead></table>')
  })
})

describe('code blocks', () => {
  const code = (s: string, language?: string) =>
    doc({ type: 'codeBlock', ...(language ? { attrs: { language } } : {}), content: [text(s)] })

  it('renders escaped code with a language class', () => {
    expect(richTextToHtml(code('a < b && c\n  d', 'ts'), resolve)).toBe(
      '<pre><code class="language-ts">a &lt; b &amp;&amp; c\n  d</code></pre>',
    )
  })

  it('renders without a class when there is no language', () => {
    expect(richTextToHtml(code('x'), resolve)).toBe('<pre><code>x</code></pre>')
  })

  it('keeps a language like c# as written', () => {
    expect(richTextToHtml(code('x', 'c#'), resolve)).toContain('class="language-c#"')
  })

  it('puts highlighter output inside the core wrapper', () => {
    const highlight = vi.fn(() => raw('<span class="k">const</span>'))
    expect(richTextToHtml(code('const', 'ts'), resolve, { highlight })).toBe(
      '<pre><code class="language-ts"><span class="k">const</span></code></pre>',
    )
    expect(highlight).toHaveBeenCalledWith('const', 'ts')
  })

  it('passes undefined when there is no language', () => {
    const highlight = vi.fn(() => null)
    richTextToHtml(code('x'), resolve, { highlight })
    expect(highlight).toHaveBeenCalledWith('x', undefined)
  })

  it('falls back to escaped text when the highlighter returns null', () => {
    expect(richTextToHtml(code('<a>', 'ts'), resolve, { highlight: () => null })).toContain('&lt;a&gt;')
  })

  it('escapes a plain string from the highlighter', () => {
    const highlight = (() => '<b>') as unknown as CodeHighlighter
    expect(richTextToHtml(code('x', 'ts'), resolve, { highlight })).toContain('&lt;b&gt;')
  })

  it('renders a doc without code blocks the same with or without options', () => {
    expect(richTextToHtml(full, resolve, {})).toBe(richTextToHtml(full, resolve))
  })
})

describe('heading ids', () => {
  const h = (t: string, level = 2) => ({ type: 'heading', attrs: { level }, content: [text(t)] })
  const many = doc(
    h('A'),
    h('A'),
    h('A 2'),
    h('!!!'),
    h('Créer un site'),
    h('  Two   words  '),
    { type: 'heading', attrs: { level: 3 }, content: [text('Run '), { type: 'text', text: 'npm test', marks: [{ type: 'code' }] }] },
  )
  const ids = ['a', 'a-2', 'a-2-2', 'section', 'créer-un-site', 'two-words', 'run-npm-test']

  it('adds no ids by default', () => {
    expect(richTextToHtml(doc(h('Packing a release')), resolve)).toBe('<h2>Packing a release</h2>')
  })

  it('adds ids on request, with an optional prefix', () => {
    expect(richTextToHtml(doc(h('Packing a release')), resolve, { headingIds: true })).toBe('<h2 id="packing-a-release">Packing a release</h2>')
    expect(richTextToHtml(doc(h('Packing a release')), resolve, { headingIds: { prefix: 'doc-' } })).toContain('id="doc-packing-a-release"')
  })

  it('keeps ids unique and matches richTextHeadings', () => {
    const html = richTextToHtml(many, resolve, { headingIds: true })
    expect([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])).toEqual(ids)
    const list = richTextHeadings(many)
    expect(list.map((x) => x.id)).toEqual(ids)
    expect(list[6]).toEqual({ level: 3, text: 'Run npm test', id: 'run-npm-test' })
    expect(richTextHeadings(many, { prefix: 'p-' }).map((x) => x.id)).toEqual(ids.map((i) => `p-${i}`))
  })

  it('numbers headings in blockquotes in document order', () => {
    const d = doc(h('Hi'), { type: 'blockquote', content: [h('Hi')] }, h('Hi'))
    const html = richTextToHtml(d, resolve, { headingIds: true })
    expect([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])).toEqual(['hi', 'hi-2', 'hi-3'])
    expect(richTextHeadings(d).map((x) => x.id)).toEqual(['hi', 'hi-2', 'hi-3'])
  })

  it('keeps combining marks in ids', () => {
    const d = doc(h('हिन्दी'), h('Crème brûlée'.normalize('NFD')))
    expect(richTextHeadings(d).map((x) => x.id)).toEqual(['हिन्दी', 'crème-brûlée'])
    expect(richTextToHtml(d, resolve, { headingIds: true })).toContain('id="हिन्दी"')
  })

  it('gives no headings for no doc', () => {
    expect(richTextHeadings(null)).toEqual([])
    expect(richTextHeadings(undefined)).toEqual([])
  })
})
