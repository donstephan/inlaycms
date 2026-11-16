import { richTextToHtml } from '../../src/core/richtext/html.js'
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
