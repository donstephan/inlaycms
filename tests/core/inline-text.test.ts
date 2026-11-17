import { z } from 'zod'
import { validateContent } from '../../src/core/content/validate.js'
import { storedTypeSchema } from '../../src/core/export/schema.js'
import { f } from '../../src/core/fields/builtins.js'
import { fieldMeta, type AgentRefs } from '../../src/core/fields/define.js'
import { extractRefs } from '../../src/core/fields/walk.js'
import { t } from '../../src/core/messages/index.js'
import { defineCollection, defineSite, defineTemplate } from '../../src/core/registry/define.js'
import { buildRegistry } from '../../src/core/registry/registry.js'
import type { RichTextResolver } from '../../src/core/richtext/html.js'
import { inlineTextToHtml, markdownToInlineText } from '../../src/core/richtext/inline.js'
import type { RichTextDoc } from '../../src/core/richtext/schema.js'

const id = '6f1c2b1e-8a3d-4b7e-9c2a-000000000001'
const resolve: RichTextResolver = { link: () => '/linked', image: () => null }
const refs = {} as AgentRefs

const para = (...content: unknown[]) => ({ type: 'paragraph', content })
const text = (s: string, marks?: unknown[]) => ({ type: 'text', text: s, ...(marks && { marks }) })
const doc = (...content: unknown[]) => ({ type: 'doc', content })

function inline(markdown: string): RichTextDoc {
  const result = markdownToInlineText(markdown)
  if (!result.ok) throw new Error(result.problems.map((p) => p.message).join('\n'))
  return result.doc
}

describe('f.inlineText', () => {
  const field = f.inlineText({ label: 'Headline' })
  const meta = fieldMeta(field)!

  it('stores one paragraph with bold, italic and links, and refuses more', () => {
    expect(meta.kind).toBe('inlineText')
    const draft = meta.draft!
    const one = doc(
      para(
        text('One '),
        text('two', [{ type: 'bold' }]),
        text(' three', [{ type: 'italic' }]),
        text(' four', [{ type: 'link', attrs: { href: 'https://x.test' } }]),
      ),
    )
    expect(draft.safeParse(one)).toEqual({ success: true, data: one })
    expect(draft.safeParse(doc(para(text('a'), text('b'))))).toEqual({ success: true, data: doc(para(text('ab'))) })
    expect(draft.safeParse(doc()).success).toBe(true)

    expect(draft.safeParse(doc(para(text('One')), para(text('Two')))).success).toBe(false)
    expect(draft.safeParse(doc({ type: 'heading', attrs: { level: 2 }, content: [text('H')] })).success).toBe(false)
    expect(
      draft.safeParse(doc({ type: 'bulletList', content: [{ type: 'listItem', content: [para(text('x'))] }] })).success,
    ).toBe(false)
    expect(draft.safeParse(doc(para(text('a'), { type: 'hardBreak' }, text('b')))).success).toBe(false)
    expect(draft.safeParse(doc(para({ type: 'image', attrs: { media: 'a'.repeat(64) } }))).success).toBe(false)
  })

  it('counts maxLength on the plain text', () => {
    const Story = defineTemplate({
      name: 'story',
      label: 'Story',
      fields: z.object({
        title: f.text({ label: 'Title' }),
        headline: f.inlineText({ label: 'Headline', maxLength: 5 }),
      }),
    })
    const registry = buildRegistry(
      defineSite({
        locales: ['en'],
        defaultLocale: 'en',
        collections: [defineCollection({ name: 'stories', label: 'Stories', template: Story })],
      }),
    )
    const data = (headline: RichTextDoc) => ({ slug: 'a', fields: { title: 'A', headline }, slots: {} })
    expect(validateContent(registry, 'stories', data(inline('**Hello**')), 'strict').ok).toBe(true)
    const result = validateContent(registry, 'stories', data(inline('Hello!')), 'strict')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({
      code: 'too_long',
      message: t('issue.tooLong', { field: 'Headline', max: 5 }),
    })
  })

  it('names its kind in the stored schema', () => {
    const Story = defineTemplate({
      name: 'story',
      label: 'Story',
      fields: z.object({ title: f.text({ label: 'Title' }), headline: f.inlineText({ label: 'Headline', maxLength: 5 }) }),
    })
    const registry = buildRegistry(
      defineSite({
        locales: ['en'],
        defaultLocale: 'en',
        collections: [defineCollection({ name: 'stories', label: 'Stories', template: Story })],
      }),
    )
    const stored = (storedTypeSchema(registry, 'stories') as any).properties.fields.properties.headline
    expect(stored).toMatchObject({ title: 'Headline', inlineText: { features: ['bold', 'italic', 'code', 'link'] } })
  })

  it('reads and writes one line of Markdown', () => {
    const agent = meta.agent!
    expect(agent.schema).toMatchObject({ type: 'string', contentMediaType: 'text/markdown' })
    const line = 'One **two** [three](https://x.test)'
    const written = agent.write(line)
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.value).toEqual(doc(para(text('One '), text('two', [{ type: 'bold' }]), text(' '), text('three', [{ type: 'link', attrs: { href: 'https://x.test' } }]))))
    expect(agent.read(written.value, refs)).toBe(line)

    expect(agent.write('One\n\nTwo')).toEqual({ ok: false, problems: [t('richtext.inlineParagraphs', { line: 3 })] })
    const heading = agent.write('## Head')
    expect(heading.ok).toBe(false)
    if (heading.ok) return
    expect(heading.problems.join('\n')).toContain(t('richtext.feature.heading'))
  })

  it('tracks an internal link as a document ref', () => {
    const linked = doc(para(text('See '), text('this', [{ type: 'link', attrs: { document: id } }])))
    expect(extractRefs(field, linked)).toEqual([{ kind: 'document', id }])
  })

  it('takes code, written between backticks', () => {
    const agent = meta.agent!
    const line = 'Run `simulate_project` first'
    const written = agent.write(line)
    expect(written).toEqual({ ok: true, value: doc(para(text('Run '), text('simulate_project', [{ type: 'code' }]), text(' first'))) })
    if (!written.ok) return
    expect(agent.read(written.value, refs)).toBe(line)
  })

  it('renders the first paragraph inline', () => {
    expect(inlineTextToHtml(inline('**Big** news'), resolve)).toBe('<strong>Big</strong> news')
    expect(inlineTextToHtml(inline('Run `a<b`'), resolve)).toBe('Run <code>a&lt;b</code>')
    const stored = doc(para(text('First')), para(text('Second'))) as RichTextDoc
    expect(inlineTextToHtml(stored, resolve)).toBe('First')
    expect(inlineTextToHtml(doc() as RichTextDoc, resolve)).toBe('')
  })
})
